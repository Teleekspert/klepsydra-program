// Krok 9 planu wdrożenia: czy Streamflow (blokada + vesting) działa z tokenem Klepsydry
// (Token-2022 z transfer hookiem). Lokalny walidator z kopią programów Streamflow z devnetu.
// Uruchomienie: npm install @streamflow/stream@13.4.0 bn.js; solana-test-validator z --clone-upgradeable-program
// HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ (Streamflow) i tym programem; node tests/streamflow-hook-test.mjs
import fs from "node:fs";
import os from "node:os";
import anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, createInitializeMintInstruction, createInitializeTransferHookInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createSetAuthorityInstruction, AuthorityType, getAccount,
} from "@solana/spl-token";
import { SolanaStreamClient, ICluster } from "@streamflow/stream";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const PROJECT = process.env.PROJECT || ".";
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`))));
const idl = JSON.parse(fs.readFileSync(fs.existsSync(`${PROJECT}/target/idl/time_dividend.json`) ? `${PROJECT}/target/idl/time_dividend.json` : `${PROJECT}/idl/time_dividend.json`));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const DEC = 9;
const U = (n) => BigInt(n) * 10n ** BigInt(DEC);
const UB = (n) => new BN(U(n).toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, info = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${info ? " — " + info : ""}`);
  ok ? pass++ : fail++;
}
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
const configPda = (mint) => pda([Buffer.from("config"), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from("extra-account-metas"), mint.toBuffer()]);
const holderPda = (ta) => pda([Buffer.from("holder"), ta.toBuffer()]);
const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const send = (ixs, signers) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers], { commitment: "confirmed" });
const registered = async (mint) => BigInt((await program.account.config.fetch(configPda(mint))).registeredSupply.toString());
const balance = async (mint, owner) => (await getAccount(conn, ata(mint, owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
const accounts = (mint, owner) => ({
  owner: owner.publicKey, config: configPda(mint), mint, tokenAccount: ata(mint, owner.publicKey),
  holder: holderPda(ata(mint, owner.publicKey)), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
});
const register = (mint, owner) => program.methods.register().accountsPartial(accounts(mint, owner)).signers([owner]).rpc();

async function main() {
  const sig = await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  const bob = Keypair.generate();
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: bob.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], []);

  // token Klepsydry: hook, bez freeze, 1 000 000 dla twórcy (payer), potem odebranie uprawnień i initialize
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const len = getMintLen([ExtensionType.TransferHook]);
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: len,
      lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(mint, payer.publicKey, PID, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, DEC, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ], [mintKp]);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, payer.publicKey), payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, bob.publicKey), bob.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, ata(mint, payer.publicKey), payer.publicKey, U(1_000_000), [], TOKEN_2022_PROGRAM_ID),
  ], []);
  await send([
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.TransferHookProgramId, null, [], TOKEN_2022_PROGRAM_ID),
  ], []);
  await program.methods.initialize().accountsPartial({ payer: payer.publicKey, mint, config: configPda(mint),
    extraAccountMetaList: metaPda(mint), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  await register(mint, payer);
  await register(mint, bob);
  check("start: registered_supply = 1 000 000 (twórca)", (await registered(mint)) === U(1_000_000));

  const client = new SolanaStreamClient(RPC, ICluster.Local, "confirmed");
  const now = Math.floor(Date.now() / 1000);
  const common = {
    tokenId: mint.toBase58(), tokenProgramId: TOKEN_2022_PROGRAM_ID, recipient: bob.publicKey.toBase58(),
    cancelableBySender: false, cancelableByRecipient: false, transferableBySender: false, transferableByRecipient: false,
    canTopup: false, automaticWithdrawal: false,
  };

  // A) blokada (jak 5% twórcy): całość odblokowana w chwili cliff
  let lockId;
  try {
    const lockStart = now + 25;
    const res = await client.create(
      { ...common, name: "KLEPS lock", amount: UB(100_000), period: 1, start: lockStart, cliff: lockStart,
        cliffAmount: UB(100_000).sub(new BN(1)), amountPerPeriod: new BN(1) },
      { sender: payer, isNative: false });
    lockId = res.metadataId;
    check("Streamflow: utworzenie blokady 100 000 $KLEPS", true, lockId);
  } catch (e) {
    check("Streamflow: utworzenie blokady 100 000 $KLEPS", false, String(e?.message || e).slice(0, 400));
    console.log(e?.logs || e?.transactionLogs || "");
  }

  // B) vesting liniowy (jak 10% rezerwy): 200 000 w 10 ratach co 2 s
  let vestId;
  try {
    const vStart = now + 25;
    const res = await client.create(
      { ...common, name: "KLEPS vesting", amount: UB(200_000), period: 2, start: vStart, cliff: vStart,
        cliffAmount: new BN(0), amountPerPeriod: UB(20_000) },
      { sender: payer, isNative: false });
    vestId = res.metadataId;
    check("Streamflow: utworzenie vestingu 200 000 $KLEPS", true, vestId);
  } catch (e) {
    check("Streamflow: utworzenie vestingu 200 000 $KLEPS", false, String(e?.message || e).slice(0, 400));
    console.log(e?.logs || e?.transactionLogs || "");
  }

  if (lockId || vestId) {
    // registered_supply musi równać się sumie sald zarejestrowanych (twórca + Bob); escrow i opłata Streamflow są poza podziałem
    const creator = await balance(mint, payer.publicKey);
    const fee = U(1_000_000) - creator - U((lockId ? 100_000 : 0) + (vestId ? 200_000 : 0));
    console.log(`     opłata Streamflow w tokenach: ${Number(fee) / 1e9} $KLEPS`);
    check("hook: tokeny w escrow Streamflow nie zarabiają (registered = saldo twórcy)", (await registered(mint)) === creator,
      `${(await registered(mint)) / 10n ** 9n}`);
  }

  console.log("czekam na odblokowanie (~50 s)…");
  await sleep(50_000);

  for (const [name, id, amount] of [["blokady", lockId, 100_000], ["vestingu", vestId, 200_000]]) {
    if (!id) continue;
    try {
      await client.withdraw({ id }, { invoker: bob });
      check(`Streamflow: wypłata z ${name} do Boba`, true);
    } catch (e) {
      check(`Streamflow: wypłata z ${name} do Boba`, false, String(e?.message || e).slice(0, 400));
      console.log(e?.logs || e?.transactionLogs || "");
    }
  }
  const bobBal = await balance(mint, bob.publicKey);
  const expBob = (lockId ? 100_000n : 0n) + (vestId ? 200_000n : 0n);
  check("Bob dostał wszystkie odblokowane tokeny", bobBal === expBob * 10n ** 9n, `${bobBal / 10n ** 9n} $KLEPS`);
  const creatorNow = await balance(mint, payer.publicKey);
  const reg = await registered(mint);
  check("hook: po wypłacie Bob (zarejestrowany) znów liczy się do podziału", reg === creatorNow + bobBal, `${reg / 10n ** 9n}`);

  // dywidenda po wypłacie: 1 SOL → twórca 70%, Bob 30%
  await program.methods.distribute(new anchor.BN(LAMPORTS_PER_SOL))
    .accountsPartial({ payer: payer.publicKey, config: configPda(mint), systemProgram: SystemProgram.programId }).rpc();
  const before = BigInt(await conn.getBalance(bob.publicKey));
  const { owner, config, tokenAccount, holder } = accounts(mint, bob);
  await program.methods.claim(new anchor.BN(0))
    .accountsPartial({ owner, config, mint, tokenAccount, holder, recipient: bob.publicKey }).signers([bob]).rpc();
  const got = BigInt(await conn.getBalance(bob.publicKey)) - before;
  const expGot = (BigInt(LAMPORTS_PER_SOL) * bobBal) / reg;
  check("dywidenda: Bob dostaje swoją część 1 SOL (saldo/zarejestrowane)", got >= expGot - 2n && got <= expGot + 2n, `${Number(got) / 1e9} SOL`);

  console.log(`\nWYNIK: ${pass} OK, ${fail} FAIL (mint ${mint.toBase58()})`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
