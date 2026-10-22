// Przygotowanie kont do lokalnego walidatora: klucz mintu z góry, token badge DLMM dla tego mintu
// (symulacja: Meteora wydała badge), PresetParameter2 z mainnetu.
const fs = require("node:fs");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const dl = require("@meteora-ag/dlmm"); const DLMM = dl; const { deriveTokenBadge, IDL } = dl;
(async () => {
const PROG = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const main = new Connection(process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com", "confirmed");
const mintKp = Keypair.generate();
fs.writeFileSync("mint-kp.json", JSON.stringify([...mintKp.secretKey]));
const [badge] = deriveTokenBadge(mintKp.publicKey, PROG);
const disc = Buffer.from(IDL.accounts.find((a) => a.name === "TokenBadge").discriminator);
const data = Buffer.concat([disc, mintKp.publicKey.toBuffer(), Buffer.alloc(128)]);
const rent = await main.getMinimumBalanceForRentExemption(data.length);
const acct = (pubkey, d, lamports) => ({ pubkey: pubkey.toBase58(), account: { lamports, data: [d.toString("base64"), "base64"], owner: PROG.toBase58(), executable: false, rentEpoch: 0, space: d.length } });
fs.writeFileSync("badge.json", JSON.stringify(acct(badge, data, rent)));
console.log("mint", mintKp.publicKey.toBase58(), "badge", badge.toBase58());
const presets = await DLMM.getAllPresetParameters(main);
const p2 = presets.presetParameter2 || [];
console.log("preset2 count", p2.length, "bin steps", [...new Set(p2.map((p) => p.account.binStep))].sort((a, b) => a - b).join(","));
const pick = p2.filter((p) => p.account.binStep === 100).sort((a, b) => a.account.baseFactor - b.account.baseFactor)[0] || p2[0];
const info = await main.getAccountInfo(pick.publicKey);
fs.writeFileSync("preset.json", JSON.stringify({ pubkey: pick.publicKey.toBase58(), account: { lamports: info.lamports, data: [info.data.toString("base64"), "base64"], owner: info.owner.toBase58(), executable: false, rentEpoch: 0, space: info.data.length } }));
console.log("preset", pick.publicKey.toBase58(), JSON.stringify({ binStep: pick.account.binStep, baseFactor: pick.account.baseFactor, powerFactor: pick.account.baseFeePowerFactor }));
})();
