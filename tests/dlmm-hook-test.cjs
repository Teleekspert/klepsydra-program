// Czy Meteora DLMM (program z mainnetu na lokalnym walidatorze) obsłuży token Klepsydry z transfer hookiem,
// jeśli token dostanie token badge? Pełny cykl: pula, płynność, kupno, dywidenda, odbiór, sprzedaż.
// Badge wpisany do walidatora jako konto (badge.json z prep.cjs), bo initialize_token_badge wymaga admina Meteory.
// Uruchomienie (VPS ~/dev/dlmm-test): node dlmm-hook-test.cjs (walidator na 127.0.0.1:8899)
const fs = require("node:fs");
const os = require("node:os");
const anchor = require("@coral-xyz/anchor");
const BN = require("bn.js");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ExtensionType, getMintLen, createInitializeMintInstruction,
  createInitializeTransferHookInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSetAuthorityInstruction, AuthorityType, getAccount,
  createTransferCheckedInstruction, addExtraAccountMetasForExecute,
} = require("@solana/spl-token");
const DLMM = require("@meteora-ag/dlmm");
const { StrategyType } = DLMM;

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`))));
const idl = JSON.parse(fs.readFileSync(`${os.homedir()}/dev/solana-dividend-token/target/idl/time_dividend.json`));
const prov = (kp) => new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" });
const program = new anchor.Program(idl, prov(payer));
const PID = program.programId;
const pda = (s) => PublicKey.findProgramAddressSync(s, PID)[0];
const send = (ixs, signers = []) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers], { commitment: "confirmed" });
const sendTx = (tx, signers) => sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
const sol = async (pk) => (await conn.getBalance(pk)) / 1e9;
const PRESET = new PublicKey(JSON.parse(fs.readFileSync("preset.json")).pubkey);

let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name}${info ? " — " + info : ""}`); };
const logsOf = (e) => e.logs || e.transactionLogs || [];
const step = async (name, fn) => {
  try { const r = await fn(); check(name, true, typeof r === "string" ? r : ""); return r; }
  catch (e) { check(name, false, (e.message ?? String(e)).slice(0, 300)); if (logsOf(e).length) console.log(logsOf(e).slice(-14).join("\n")); throw e; }
};

async function makeHookMint(mintKp) {
  const mint = mintKp.publicKey;
  const len = getMintLen([ExtensionType.TransferHook]);
  const treasury = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: len,
      lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(mint, payer.publicKey, PID, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, 9, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treasury, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, treasury, payer.publicKey, 1_000_000_000n * 10n ** 9n, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.TransferHookProgramId, null, [], TOKEN_2022_PROGRAM_ID),
  ], [mintKp]);
  await program.methods.initialize().accountsPartial({ payer: payer.publicKey, mint, config: pda([Buffer.from("config"), mint.toBuffer()]),
    extraAccountMetaList: pda([Buffer.from("extra-account-metas"), mint.toBuffer()]),
    tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  return { mint, treasury };
}

(async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  const holderOf = (ta) => pda([Buffer.from("holder"), ta.toBuffer()]);

  // 1. token z badge (klucz z prep.cjs)
  const { mint, treasury } = await makeHookMint(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("mint-kp.json")))));
  const config = pda([Buffer.from("config"), mint.toBuffer()]);
  await program.methods.register().accountsPartial({ owner: payer.publicKey, config, mint, tokenAccount: treasury,
    holder: holderOf(treasury), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  check("token z hookiem Klepsydry gotowy", true, mint.toBase58());
  const readCfg = () => program.account.config.fetch(config);
  check("DLMM: preset z mainnetu (bin step 100)", true, PRESET.toBase58());

  // cena startowa 10 SOL : 700 mln KLEPS; SDK sortuje tokeny, więc liczymy cenę po ustaleniu, który jest X
  const kIsXGuess = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
  const priceYperX = kIsXGuess ? 10 / 700_000_000 : 700_000_000 / 10;
  const activeId = new BN(DLMM.getBinIdFromPrice(priceYperX, 100, true));

  // 2a. pula BEZ badge: powinna zostać odrzucona
  const other = await makeHookMint(Keypair.generate());
  try {
    const tx = await DLMM.createLbPair2(conn, payer.publicKey, other.mint, NATIVE_MINT, PRESET, activeId);
    await sendTx(tx, [payer]);
    check("pula bez token badge jest odrzucana", false, "pula powstała bez badge");
  } catch (e) {
    const txt = String(e.message ?? e) + " " + logsOf(e).join(" ");
    check("pula bez token badge jest odrzucana", /Error Code|custom program error/i.test(txt),
      txt.match(/Error Code: \w+|custom program error: 0x[0-9a-f]+/i)?.[0] || txt.slice(0, 200));
  }

  // 2b. pula z badge
  const [tokenX, tokenY] = kIsXGuess ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint];
  await step("DLMM: pula KLEPS/SOL z badge", async () => {
    const tx = await DLMM.createLbPair2(conn, payer.publicKey, tokenX, tokenY, PRESET, activeId);
    await sendTx(tx, [payer]);
  });
  const [pairKey] = DLMM.deriveLbPairWithPresetParamWithIndexKey(PRESET, tokenX, tokenY, DLMM.LBCLMM_PROGRAM_IDS["mainnet-beta"]
    ? new PublicKey(DLMM.LBCLMM_PROGRAM_IDS["mainnet-beta"]) : new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"));
  const dlmm = await DLMM.create(conn, pairKey, { cluster: "mainnet-beta" });
  const kIsX = dlmm.lbPair.tokenXMint.equals(mint);
  // SDK liczy konta hooka dla pustych adresów nadawcy/odbiorcy, a hook Klepsydry wymaga kont holder
  // wyprowadzonych z prawdziwych kont tokenów. DLMM szuka ich po adresie, więc podajemy komplet dla obu kierunków.
  const reserveK = kIsX ? dlmm.lbPair.reserveX : dlmm.lbPair.reserveY;
  const hookMetas = async (userAta) => {
    const all = new Map();
    for (const [src, dst] of [[userAta, reserveK], [reserveK, userAta]]) {
      const ix = createTransferCheckedInstruction(src, mint, dst, PublicKey.default, 0n, 9, [], TOKEN_2022_PROGRAM_ID);
      await addExtraAccountMetasForExecute(conn, ix, PID, src, mint, dst, PublicKey.default, 0n, "confirmed");
      for (const k of ix.keys.slice(4)) {
        const prev = all.get(k.pubkey.toBase58());
        all.set(k.pubkey.toBase58(), { pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable || !!prev?.isWritable });
      }
    }
    return [...all.values()];
  };
  const useHookAccounts = async (owner) => {
    const metas = await hookMetas(getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID));
    (kIsX ? dlmm.tokenX : dlmm.tokenY).transferHookAccountMetas = metas;
    return metas.length;
  };
  check("pula odczytana", true, `${pairKey.toBase58()}, ${kIsX ? "X = KLEPS, Y = SOL" : "X = SOL, Y = KLEPS"}, aktywny kubełek ${dlmm.lbPair.activeId}`);

  // 3. płynność: 700 mln KLEPS + 10 SOL, strategia Spot na 69 kubełkach wokół aktywnego
  const cfg0 = await readCfg();
  const position = Keypair.generate();
  await step("płynność: 10 SOL + 700 mln KLEPS (przelew przez hook)", async () => {
    await useHookAccounts(payer.publicKey);
    const act = dlmm.lbPair.activeId;
    const klepsAmt = new BN((700_000_000n * 10n ** 9n).toString()), solAmt = new BN(10 * LAMPORTS_PER_SOL);
    const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey, user: payer.publicKey,
      totalXAmount: kIsX ? klepsAmt : solAmt, totalYAmount: kIsX ? solAmt : klepsAmt,
      strategy: { minBinId: act - 34, maxBinId: act + 34, strategyType: StrategyType.Spot }, slippage: 5,
    });
    await sendTx(tx, [payer, position]);
  });
  const cfg1 = await readCfg();
  const movedOut = BigInt(cfg0.registeredSupply.toString()) - BigInt(cfg1.registeredSupply.toString());
  check("hook: tokeny w puli nie zarabiają (registered_supply spadło)", movedOut > 0n,
    `${(movedOut / 10n ** 9n).toLocaleString("pl-PL")} KLEPS wyszło z podziału`);

  // 4. kupujący: 1 SOL -> KLEPS
  const buyer = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(buyer.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const doSwap = async (user, inMint, outMint, amount) => {
    await dlmm.refetchStates();
    const swapForY = inMint.equals(dlmm.lbPair.tokenXMint);
    const binArrays = await dlmm.getBinArrayForSwap(swapForY);
    const q = dlmm.swapQuote(amount, swapForY, new BN(500), binArrays);
    await useHookAccounts(user.publicKey); // po getBinArrayForSwap, które odświeża stan puli i nadpisuje konta hooka
    const tx = await dlmm.swap({ inToken: inMint, outToken: outMint, inAmount: amount, minOutAmount: q.minOutAmount,
      lbPair: dlmm.pubkey, user: user.publicKey, binArraysPubkey: q.binArraysPubkey });
    if (process.env.DEBUG) {
      const ix = tx.instructions.find((i) => i.programId.toBase58().startsWith("LBUZ"));
      const want = (await hookMetas(getAssociatedTokenAddressSync(mint, user.publicKey, false, TOKEN_2022_PROGRAM_ID))).map((m) => m.pubkey.toBase58());
      const have = ix.keys.map((k) => k.pubkey.toBase58());
      console.log("DEBUG swap ix keys", have.length, "hook wanted", want.map((w) => w.slice(0, 6) + (have.includes(w) ? "+" : "-")).join(" "));
      console.log("DEBUG data hex", Buffer.from(ix.data).toString("hex"));
    }
    await sendTx(tx, [user]);
  };
  await step("swap: kupno KLEPS za 1 SOL (hook przy wypłacie z puli)", async () => {
    await doSwap(buyer, NATIVE_MINT, mint, new BN(LAMPORTS_PER_SOL));
    const bal = (await getAccount(conn, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    return `${(bal / 10n ** 9n).toLocaleString("pl-PL")} KLEPS`;
  });
  const buyerKleps = (await getAccount(conn, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

  // 5. rejestracja kupującego, wpłata 1 SOL do programu, odbiór
  const bprog = new anchor.Program(idl, prov(buyer));
  await step("register kupującego", () => bprog.methods.register().accountsPartial({ owner: buyer.publicKey, config, mint,
    tokenAccount: buyerAta, holder: holderOf(buyerAta), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc());
  const cfg2 = await readCfg();
  await step("distribute 1 SOL", () => program.methods.distribute(new BN(LAMPORTS_PER_SOL)).accountsPartial({
    payer: payer.publicKey, config, systemProgram: SystemProgram.programId }).rpc());
  const expected = Number((BigInt(LAMPORTS_PER_SOL) * buyerKleps) / BigInt(cfg2.registeredSupply.toString())) / 1e9;
  const before = await sol(buyer.publicKey);
  await step("claim kupującego", () => bprog.methods.claim(new BN(0)).accountsPartial({ owner: buyer.publicKey, config, mint,
    tokenAccount: buyerAta, holder: holderOf(buyerAta), recipient: buyer.publicKey, systemProgram: SystemProgram.programId }).rpc());
  const got = (await sol(buyer.publicKey)) - before;
  check("kupujący dostał swoją część", Math.abs(got - expected) < 0.00002, `oczekiwane ${expected.toFixed(6)}, otrzymał ${got.toFixed(6)} SOL (minus opłata)`);

  // 6. sprzedaż połowy KLEPS z powrotem do puli
  await step("swap: sprzedaż połowy KLEPS (hook przy wpłacie do puli)", () => doSwap(buyer, mint, NATIVE_MINT, new BN((buyerKleps / 2n).toString())));
  const h = await program.account.holder.fetch(holderOf(buyerAta));
  check("hook: saldo kupującego w programie po sprzedaży", BigInt(h.lastBalance.toString()) === buyerKleps - buyerKleps / 2n,
    `last_balance ${(BigInt(h.lastBalance.toString()) / 10n ** 9n).toLocaleString("pl-PL")} KLEPS`);

  console.log(`\nWYNIK: ${pass} OK, ${fail} FAIL`);
  process.exit(0);
})().catch(() => { console.log(`\nPRZERWANE: ${pass} OK, ${fail} FAIL`); process.exit(1); });
