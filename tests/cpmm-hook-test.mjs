// Czy Raydium CPMM (program z mainnetu sklonowany na lokalny walidator) przyjmie token Klepsydry z transfer hookiem?
// Uruchomienie: node cpmm-hook-test.mjs (walidator na 127.0.0.1:8899)
import fs from "node:fs";
import os from "node:os";
import anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, ExtensionType, getMintLen, createInitializeMintInstruction,
  createInitializeTransferHookInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSetAuthorityInstruction, AuthorityType,
} from "@solana/spl-token";
import { Raydium, TxVersion, CREATE_CPMM_POOL_PROGRAM, CREATE_CPMM_POOL_FEE_ACC } from "@raydium-io/raydium-sdk-v2";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`))));
const idl = JSON.parse(fs.readFileSync(process.env.IDL || "idl/time_dividend.json"));
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" }));
const PID = program.programId;
const pda = (s) => PublicKey.findProgramAddressSync(s, PID)[0];
const send = (ixs, signers = []) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers], { commitment: "confirmed" });

await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
console.log("payer", payer.publicKey.toBase58(), "SOL", (await conn.getBalance(payer.publicKey)) / 1e9);

// 1. token jak na devnecie: Token-2022 + hook Klepsydry, bez uprawnień, initialize + register skarbca
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
await program.methods.initialize().accountsPartial({ payer: payer.publicKey, mint, config,
  extraAccountMetaList: pda([Buffer.from("extra-account-metas"), mint.toBuffer()]),
  tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
await program.methods.register().accountsPartial({ owner: payer.publicKey, config, mint, tokenAccount: treasury,
  holder: pda([Buffer.from("holder"), treasury.toBuffer()]), tokenProgram: TOKEN_2022_PROGRAM_ID,
  systemProgram: SystemProgram.programId }).rpc();
console.log("OK   token z hookiem gotowy:", mint.toBase58());

// 2. pula CPMM: 10 SOL + 700 mln KLEPS, konfiguracja 0 (0,25%) z mainnetu
const raydium = await Raydium.load({ connection: conn, owner: payer, cluster: "mainnet", disableFeatureCheck: true,
  disableLoadToken: true, blockhashCommitment: "confirmed" });
const feeConfigs = await raydium.api.getCpmmConfigs();
const feeConfig = feeConfigs.find((c) => c.index === 0);
console.log("feeConfig", feeConfig.id, "tradeFeeRate", feeConfig.tradeFeeRate);
try {
  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: CREATE_CPMM_POOL_PROGRAM,
    poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
    mintA: { address: NATIVE_MINT.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: 9 },
    mintB: { address: mint.toBase58(), programId: TOKEN_2022_PROGRAM_ID.toBase58(), decimals: 9 },
    mintAAmount: new BN(10 * LAMPORTS_PER_SOL),
    mintBAmount: new BN((700_000_000n * 10n ** 9n).toString()),
    startTime: new BN(0),
    feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.LEGACY,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  console.log("UWAGA: pula utworzona", extInfo.address.poolId.toBase58(), txId);
} catch (e) {
  console.log("FAIL tworzenie puli CPMM:", e.message ?? e);
  const logs = e.logs ?? e.transactionLogs ?? e?.cause?.logs;
  if (logs) console.log(logs.join("\n"));
  else console.log(JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 2000));
}
