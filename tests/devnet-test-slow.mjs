// Test pełnego cyklu na devnecie: mint z hookiem → initialize → register →
// transfery → distribute → burn → claim → unregister + testy negatywne.
// Uruchomienie: node tests/devnet-test.mjs  (z katalogu projektu, po anchor deploy)
import fs from "node:fs";
import os from "node:os";
import anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, createInitializeMintInstruction,
  createInitializeTransferHookInstruction, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createSetAuthorityInstruction,
  AuthorityType, createTransferCheckedWithTransferHookInstruction, createBurnCheckedInstruction, getAccount,
} from "@solana/spl-token";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true });
{
  const GAP = Number(process.env.RPC_GAP_MS || 900);
  const raw = conn._rpcRequest.bind(conn);
  let last = 0, chain = Promise.resolve();
  conn._rpcRequest = (method, args) => {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = last + GAP - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        try {
          return await raw(method, args);
        } catch (e) {
          if (!/429/.test(String(e && e.message)) || attempt >= 8) throw e;
          const back = 3000 * (attempt + 1);
          console.log(`  (429 przy ${method}, czekam ${back / 1000}s)`);
          await new Promise((r) => setTimeout(r, back));
        }
      }
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`))));
const idl = JSON.parse(fs.readFileSync(fs.existsSync("target/idl/time_dividend.json") ? "target/idl/time_dividend.json" : "idl/time_dividend.json"));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const DEC = 9;
const U = (n) => BigInt(n) * 10n ** BigInt(DEC);
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);

let pass = 0, fail = 0;
function check(name, ok, info = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${info ? " — " + info : ""}`);
  ok ? pass++ : fail++;
}
const near = (a, b, tol = 2n) => (a > b ? a - b : b - a) <= tol;

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
const configPda = (mint) => pda([Buffer.from("config"), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from("extra-account-metas"), mint.toBuffer()]);
const holderPda = (ta) => pda([Buffer.from("holder"), ta.toBuffer()]);

async function confirmPoll(sig) {
  for (let i = 0; i < 60; i++) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value[0];
    if (st && st.err) throw new Error("Transakcja nieudana: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Brak potwierdzenia: " + sig);
}
async function send(ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer, ...signers);
  const sig = await conn.sendRawTransaction(tx.serialize());
  return confirmPoll(sig);
}

async function fund(kp, lamports) {
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports })], []);
}

async function createMint({ freeze = false } = {}) {
  const mintKp = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferHook]);
  const rent = await conn.getMinimumBalanceForRentExemption(len);
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(mintKp.publicKey, payer.publicKey, PID, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mintKp.publicKey, DEC, payer.publicKey, freeze ? payer.publicKey : null, TOKEN_2022_PROGRAM_ID),
  ], [mintKp]);
  return mintKp.publicKey;
}

const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
const createAta = (mint, owner) =>
  send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, owner), owner, mint, TOKEN_2022_PROGRAM_ID)], []);

async function transfer(mint, from, to, amount) {
  const ix = await createTransferCheckedWithTransferHookInstruction(
    conn, ata(mint, from.publicKey), mint, ata(mint, to), from.publicKey, amount, DEC, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  return send([ix], [from]);
}

const accounts = (mint, owner) => ({
  owner: owner.publicKey, config: configPda(mint), mint, tokenAccount: ata(mint, owner.publicKey),
  holder: holderPda(ata(mint, owner.publicKey)), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
});

const register = (mint, owner) => program.methods.register().accountsPartial(accounts(mint, owner)).signers([owner]).rpc();
const distribute = (mint, lamports) =>
  program.methods.distribute(new anchor.BN(lamports.toString()))
    .accountsPartial({ payer: payer.publicKey, config: configPda(mint), systemProgram: SystemProgram.programId }).rpc();

async function claimAll(mint, owner) {
  const before = BigInt(await conn.getBalance(owner.publicKey));
  const { owner: o, config, mint: m, tokenAccount, holder } = accounts(mint, owner);
  await program.methods.claim(new anchor.BN(0))
    .accountsPartial({ owner: o, config, mint: m, tokenAccount, holder, recipient: owner.publicKey })
    .signers([owner]).rpc({ skipPreflight: false });
  // podpisujący płaci opłatę 5000 lamportów tylko gdy jest fee payerem — tu fee payerem jest payer
  return BigInt(await conn.getBalance(owner.publicKey)) - before;
}

async function expectError(name, fn, code) {
  try {
    await fn();
    check(name, false, "brak błędu");
  } catch (e) {
    const s = String(e?.message || e) + JSON.stringify(e?.logs || e?.transactionLogs || "");
    check(name, s.includes(code), s.includes(code) ? code : s.slice(0, 200));
  }
}

async function main() {
  console.log("Program:", PID.toBase58(), "payer:", payer.publicKey.toBase58(), "SOL:", sol(await conn.getBalance(payer.publicKey)));

  // --- negatywny: mint z freeze authority musi zostać odrzucony
  const badMint = await createMint({ freeze: true });
  await send([
    createSetAuthorityInstruction(badMint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(badMint, payer.publicKey, AuthorityType.TransferHookProgramId, null, [], TOKEN_2022_PROGRAM_ID),
  ], []);
  await expectError("initialize odrzuca mint z freeze authority", () =>
    program.methods.initialize().accountsPartial({ payer: payer.publicKey, mint: badMint, config: configPda(badMint),
      extraAccountMetaList: metaPda(badMint), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc(),
    "FreezeAuthorityActive");

  // --- właściwy mint: 1 000 000 tokenów dla Alicji, potem odebranie uprawnień
  const alice = Keypair.generate(), bob = Keypair.generate(), carol = Keypair.generate();
  fs.writeFileSync("/tmp/kleps-test-keys.json", JSON.stringify([alice, bob, carol].map((k) => Array.from(k.secretKey))));
  for (const k of [alice, bob, carol]) await fund(k, 0.012 * LAMPORTS_PER_SOL);
  const mint = await createMint();
  for (const k of [alice, bob, carol]) await createAta(mint, k.publicKey);
  await send([createMintToInstruction(mint, ata(mint, alice.publicKey), payer.publicKey, U(1_000_000), [], TOKEN_2022_PROGRAM_ID)], []);

  await expectError("initialize odrzuca mint z aktywnym mint authority", () =>
    program.methods.initialize().accountsPartial({ payer: payer.publicKey, mint, config: configPda(mint),
      extraAccountMetaList: metaPda(mint), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc(),
    "MintAuthorityActive");

  await send([
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.TransferHookProgramId, null, [], TOKEN_2022_PROGRAM_ID),
  ], []);
  await program.methods.initialize().accountsPartial({ payer: payer.publicKey, mint, config: configPda(mint),
    extraAccountMetaList: metaPda(mint), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  check("initialize na czystym mincie", true, mint.toBase58());

  // --- rejestracja i transfery z hookiem
  await register(mint, alice);
  await register(mint, bob);
  await transfer(mint, alice, bob.publicKey, U(250_000));
  let cfg = await program.account.config.fetch(configPda(mint));
  check("hook: registered_supply po transferze = 1 000 000", BigInt(cfg.registeredSupply.toString()) === U(1_000_000));

  // wypłata 1: 0,1 SOL → Alicja 75%, Bob 25%
  await distribute(mint, 10_000_000n);
  // Alicja przekazuje Bobowi kolejne 250k — naliczone już SOL zostaje u niej
  await transfer(mint, alice, bob.publicKey, U(250_000));
  // wypłata 2: 0,1 SOL → 50/50
  await distribute(mint, 10_000_000n);
  // Alicja wysyła 100k do niezarejestrowanej Karoliny → wypadają z podziału
  await transfer(mint, alice, carol.publicKey, U(100_000));
  cfg = await program.account.config.fetch(configPda(mint));
  check("hook: transfer do niezarejestrowanego zmniejsza registered_supply", BigInt(cfg.registeredSupply.toString()) === U(900_000));
  // wypłata 3: 0,09 SOL zwykłym przelewem + distribute(0) → Alicja 400k/900k, Bob 500k/900k
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: configPda(mint), lamports: 9_000_000 })], []);
  await distribute(mint, 0n);
  // Bob spala 100k (bez hooka) — od teraz zarabia na 400k, nie traci naliczonego
  await send([createBurnCheckedInstruction(ata(mint, bob.publicKey), mint, bob.publicKey, U(100_000), DEC, [], TOKEN_2022_PROGRAM_ID)], [bob]);

  const aliceGot = await claimAll(mint, alice);
  const expA = 7_500_000n + 5_000_000n + 4_000_000n; // 0,075 + 0,05 + 0,04
  check("claim Alicja = 0,0165 SOL", near(aliceGot, expA), `otrzymała ${sol(aliceGot)}`);

  // wypłata 4 po spaleniu: claim Boba synchronizuje saldo, potem 0,08 SOL dzielone 400k/400k
  const bobFirst = await claimAll(mint, bob);
  const expB1 = 2_500_000n + 5_000_000n + 5_000_000n; // 0,025 + 0,05 + 0,05
  check("claim Bob = 0,0125 SOL (burn nie zabrał naliczonego)", near(bobFirst, expB1), `otrzymał ${sol(bobFirst)}`);
  cfg = await program.account.config.fetch(configPda(mint));
  check("burn zsynchronizowany: registered_supply = 800 000", BigInt(cfg.registeredSupply.toString()) === U(800_000));
  await distribute(mint, 8_000_000n);

  await expectError("Karolina (niezarejestrowana) nie może odebrać", () =>
    program.methods.claim(new anchor.BN(0)).accountsPartial({ ...accounts(mint, carol), recipient: carol.publicKey }).signers([carol]).rpc(),
    "AccountNotInitialized");

  // unregister Boba: wypłata 0,04 SOL + zwrot czynszu rekordu
  const bobBefore = BigInt(await conn.getBalance(bob.publicKey));
  const { owner, config, mint: m, tokenAccount, holder } = accounts(mint, bob);
  await program.methods.unregister().accountsPartial({ owner, config, mint: m, tokenAccount, holder }).signers([bob]).rpc();
  const bobDelta = BigInt(await conn.getBalance(bob.publicKey)) - bobBefore;
  check("unregister Bob: 0,004 SOL + zwrot czynszu", bobDelta > 4_000_000n && bobDelta < 7_000_000n, `+${sol(bobDelta)}`);
  cfg = await program.account.config.fetch(configPda(mint));
  check("po unregister registered_supply = 400 000 (Alicja)", BigInt(cfg.registeredSupply.toString()) === U(400_000));

  // Bob dalej może handlować po wyrejestrowaniu (hook pomija brak rekordu)
  await transfer(mint, bob, alice.publicKey, U(100_000));
  cfg = await program.account.config.fetch(configPda(mint));
  check("transfer od niezarejestrowanego do zarejestrowanego", BigInt(cfg.registeredSupply.toString()) === U(500_000));

  const aliceLast = await claimAll(mint, alice);
  check("Alicja dostaje 0,004 z wypłaty 4", near(aliceLast, 4_000_000n), `otrzymała ${sol(aliceLast)}`);

  // bezpośrednie wywołanie hooka poza transferem
  await expectError("hook wywołany ręcznie jest odrzucany", () =>
    program.methods.transferHook(new anchor.BN(1)).accountsPartial({
      sourceToken: ata(mint, alice.publicKey), mint, destinationToken: ata(mint, bob.publicKey), owner: alice.publicKey,
      extraAccountMetaList: metaPda(mint), config: configPda(mint),
      sourceHolder: holderPda(ata(mint, alice.publicKey)), destinationHolder: holderPda(ata(mint, bob.publicKey)),
    }).rpc(), "NotTransferring");

  cfg = await program.account.config.fetch(configPda(mint));
  console.log(`\nRozdzielono ${sol(cfg.totalDistributed)} SOL, odebrano ${sol(cfg.totalClaimed)} SOL, mint ${mint.toBase58()}`);

  // zwrot reszty SOL z kont testowych do płatnika (devnet SOL jest rzadki)
  for (const k of [alice, bob, carol]) {
    const bal = await conn.getBalance(k.publicKey);
    if (bal > 10_000) await send([SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: payer.publicKey, lamports: bal - 5_000 })], [k]).catch(() => {});
  }
  console.log("Saldo płatnika po teście:", sol(await conn.getBalance(payer.publicKey)), "SOL");
  console.log(`WYNIK: ${pass} OK, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
