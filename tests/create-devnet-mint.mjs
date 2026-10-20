// Tworzy testowy token $KLEPS na devnecie dla aplikacji kleps.io/app:
// 1 000 000 000 z transfer hookiem → skarbiec (portfel wdrożeniowy), odebranie uprawnień, initialize, register skarbca.
// Uruchomienie: set -a; . ~/.secrets/helius-devnet.env; set +a; node tests/create-devnet-mint.mjs
import fs from "node:fs";
import os from "node:os";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, createInitializeMintInstruction, createInitializeTransferHookInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createSetAuthorityInstruction, AuthorityType,
} from "@solana/spl-token";

const conn = new Connection(process.env.RPC_URL, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`))));
const idl = JSON.parse(fs.readFileSync(fs.existsSync("target/idl/time_dividend.json") ? "target/idl/time_dividend.json" : "idl/time_dividend.json"));
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" }));
const PID = program.programId;
const pda = (s) => PublicKey.findProgramAddressSync(s, PID)[0];
const send = (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers], { commitment: "confirmed" });

const mintKp = Keypair.generate();
const mint = mintKp.publicKey;
const DEC = 9;
const len = getMintLen([ExtensionType.TransferHook]);
const treasury = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

await send([
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: len,
    lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeTransferHookInstruction(mint, payer.publicKey, PID, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mint, DEC, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
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

const out = { cluster: "devnet", programId: PID.toBase58(), mint: mint.toBase58(), config: config.toBase58(),
  treasury: treasury.toBase58(), decimals: DEC, created: new Date().toISOString() };
fs.writeFileSync("devnet-mint.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log("SOL left:", (await conn.getBalance(payer.publicKey)) / 1e9);
