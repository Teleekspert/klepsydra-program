// Czy Orca Whirlpools (program z mainnetu na lokalnym walidatorze) obsłuży token Klepsydry z transfer hookiem,
// jeśli token dostanie token badge? Pełny cykl: pula, płynność, kupno, dywidenda, odbiór, sprzedaż.
// Uruchomienie: node orca-hook-test.mjs (walidator na 127.0.0.1:8899)
import fs from "node:fs";
import os from "node:os";
import anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import Decimal from "decimal.js";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ExtensionType, getMintLen, createInitializeMintInstruction,
  createInitializeTransferHookInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSetAuthorityInstruction, AuthorityType, getAccount,
} from "@solana/spl-token";
import {
  WhirlpoolContext, buildWhirlpoolClient, WhirlpoolIx, PDAUtil, PoolUtil, PriceMath, TickUtil,
  swapQuoteByInputToken, IGNORE_CACHE, ORCA_WHIRLPOOL_PROGRAM_ID,
} from "@orca-so/whirlpools-sdk";
import { Percentage, TransactionBuilder } from "@orca-so/common-sdk";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`))));
const idl = JSON.parse(fs.readFileSync(process.env.IDL || "idl/time_dividend.json"));
const prov = (kp) => new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" });
const program = new anchor.Program(idl, prov(payer));
const PID = program.programId;
const pda = (s) => PublicKey.findProgramAddressSync(s, PID)[0];
const send = (ixs, signers = []) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers], { commitment: "confirmed" });
const sol = async (pk) => (await conn.getBalance(pk)) / 1e9;

let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name}${info ? " — " + info : ""}`); };
const step = async (name, fn) => {
  try { const r = await fn(); check(name, true, typeof r === "string" ? r : ""); return r; }
  catch (e) { check(name, false, (e.message ?? String(e)).slice(0, 300)); if (e.logs) console.log(e.logs.slice(-12).join("\n")); throw e; }
};

await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");

// 1. token jak na devnecie
const mintKp = Keypair.generate();
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
const config = pda([Buffer.from("config"), mint.toBuffer()]);
const holderOf = (ta) => pda([Buffer.from("holder"), ta.toBuffer()]);
await program.methods.initialize().accountsPartial({ payer: payer.publicKey, mint, config,
  extraAccountMetaList: pda([Buffer.from("extra-account-metas"), mint.toBuffer()]),
  tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
await program.methods.register().accountsPartial({ owner: payer.publicKey, config, mint, tokenAccount: treasury,
  holder: holderOf(treasury), tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
check("token z hookiem Klepsydry gotowy", true, mint.toBase58());
const readCfg = () => program.account.config.fetch(config);

// 2. Orca
const ctx = WhirlpoolContext.from(conn, new anchor.Wallet(payer), undefined, undefined, undefined, ORCA_WHIRLPOOL_PROGRAM_ID);
const client = buildWhirlpoolClient(ctx);
const OP = ORCA_WHIRLPOOL_PROGRAM_ID;
const run = async (ix, signers = []) => {
  const tb = new TransactionBuilder(conn, ctx.wallet).addInstruction(ix);
  return tb.buildAndExecute(undefined, { skipPreflight: false });
};
// prawdziwa konfiguracja Orca z mainnetu; lokalnie podmieniony tylko token_badge_authority w config extension
// (symulacja: Orca wydała nam badge)
const whirlpoolsConfig = new PublicKey("2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ");
const extPda = PDAUtil.getConfigExtension(OP, whirlpoolsConfig);
const TS = 64;
check("Orca: konfiguracja z mainnetu (fee tier 64)", true, whirlpoolsConfig.toBase58());

// 2a. pula BEZ badge: powinna zostać odrzucona
const [mintA, mintB] = PoolUtil.orderMints(NATIVE_MINT, mint).map((m) => new PublicKey(m));
const solIsA = mintA.equals(NATIVE_MINT);
// cena = tokenB za 1 tokenA; start 10 SOL : 700 mln KLEPS
const klepsPerSol = new Decimal(70_000_000);
const price = solIsA ? klepsPerSol : new Decimal(1).div(klepsPerSol);
const initTick = PriceMath.priceToInitializableTickIndex(price, 9, 9, TS);
try {
  const { tx } = await client.createPool(whirlpoolsConfig, mintA, mintB, TS, initTick, payer.publicKey);
  await tx.buildAndExecute();
  check("pula bez token badge jest odrzucana", false, "pula powstała bez badge");
} catch (e) {
  check("pula bez token badge jest odrzucana", /UnsupportedTokenMint|0x17a[0-9a-f]|unsupported/i.test(String(e.message ?? e) + (e.logs ?? []).join(" ")),
    String(e.message ?? e).slice(0, 160));
}

// 2b. badge dla KLEPS, potem pula
await step("Orca: token badge dla KLEPS", () => run(WhirlpoolIx.initializeTokenBadgeIx(ctx.program, {
  whirlpoolsConfig, whirlpoolsConfigExtension: extPda.publicKey, tokenBadgeAuthority: payer.publicKey, tokenMint: mint,
  tokenBadgePda: PDAUtil.getTokenBadge(OP, whirlpoolsConfig, mint), funder: payer.publicKey })));
const poolKey = await step("Orca: pula SOL/KLEPS z badge", async () => {
  const { poolKey, tx } = await client.createPool(whirlpoolsConfig, mintA, mintB, TS, initTick, payer.publicKey);
  await tx.buildAndExecute();
  return poolKey.toBase58();
});
let pool = await client.getPool(poolKey, IGNORE_CACHE);

// 3. płynność na pełnym zakresie: 10 SOL + 700 mln KLEPS ze skarbca
const [lower, upper] = TickUtil.getFullRangeTickIndex(TS);
const tickTx = await pool.initTickArrayForTicks([lower, upper, pool.getData().tickCurrentIndex]);
if (tickTx) await tickTx.buildAndExecute();
const cfg0 = await readCfg();
await step("płynność: 10 SOL + 700 mln KLEPS (przelew przez hook)", async () => {
  const tenSol = new BN(10 * LAMPORTS_PER_SOL), klepsAmt = new BN((700_000_000n * 10n ** 9n).toString());
  const { tx } = await pool.openPosition(lower, upper, {
    tokenMaxA: solIsA ? tenSol : klepsAmt, tokenMaxB: solIsA ? klepsAmt : tenSol,
    minSqrtPrice: new BN(PriceMath.tickIndexToSqrtPriceX64(lower).toString()),
    maxSqrtPrice: new BN(PriceMath.tickIndexToSqrtPriceX64(upper).toString()),
  });
  await tx.buildAndExecute();
});
const cfg1 = await readCfg();
const movedOut = BigInt(cfg0.registeredSupply.toString()) - BigInt(cfg1.registeredSupply.toString());
check("hook: tokeny w puli nie zarabiają (registered_supply spadło)", movedOut > 0n,
  `${(movedOut / 10n ** 9n).toLocaleString("pl-PL")} KLEPS wyszło z podziału`);

// 4. kupujący: 1 SOL → KLEPS przez pulę
const buyer = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(buyer.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
const bctx = WhirlpoolContext.from(conn, new anchor.Wallet(buyer), undefined, undefined, undefined, OP);
const bclient = buildWhirlpoolClient(bctx);
const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
await step("swap: kupno KLEPS za 1 SOL (hook przy wypłacie z puli)", async () => {
  const p = await bclient.getPool(poolKey, IGNORE_CACHE);
  const q = await swapQuoteByInputToken(p, NATIVE_MINT, new BN(LAMPORTS_PER_SOL), Percentage.fromFraction(5, 100), OP, bctx.fetcher, IGNORE_CACHE);
  await (await p.swap(q)).buildAndExecute();
  const bal = (await getAccount(conn, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  return `${(bal / 10n ** 9n).toLocaleString("pl-PL")} KLEPS`;
});
const buyerKleps = (await getAccount(conn, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

// 5. kupujący rejestruje portfel, wpłata 1 SOL do programu, odbiór
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
await step("swap: sprzedaż połowy KLEPS (hook przy wpłacie do puli)", async () => {
  const p = await bclient.getPool(poolKey, IGNORE_CACHE);
  const q = await swapQuoteByInputToken(p, mint, new BN((buyerKleps / 2n).toString()), Percentage.fromFraction(5, 100), OP, bctx.fetcher, IGNORE_CACHE);
  await (await p.swap(q)).buildAndExecute();
});
const h = await program.account.holder.fetch(holderOf(buyerAta));
check("hook: saldo kupującego w programie po sprzedaży", BigInt(h.lastBalance.toString()) === buyerKleps - buyerKleps / 2n,
  `last_balance ${(BigInt(h.lastBalance.toString()) / 10n ** 9n).toLocaleString("pl-PL")} KLEPS`);

console.log(`\nWYNIK: ${pass} OK, ${fail} FAIL`);
