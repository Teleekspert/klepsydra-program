# Klepsydra ($KLEPS): the program

An Anchor program for Solana (Token-2022 with a transfer hook). It gives holders of one token a share of every SOL payment into the program, in proportion to their balance. The model is **T.I.M.E. Dividend** from PulseChain (`0xCA35638A3fdDD02fEC597D8c1681198C06b23F58`), with the changes listed below.

Website: **[kleps.io](https://kleps.io)** · live on-chain checks: **[kleps.io/token](https://kleps.io/token/)**

> **Status: public test on devnet. Not audited. No mainnet token exists yet.** Any $KLEPS trading before an announcement on kleps.io is a fake.

## Addresses (devnet)

| | |
|---|---|
| Program | `CfW1pzZgwzRAYb4DfnAofQ2GRBkFJFrxHAaCurEUBpao` |
| Test mint | `UbcECRuKd4qMuKHsGE11pHi5M8sN3smPz5aLLFM2Mz6` |
| Config PDA (holds the SOL) | `GKSX1dXesNK3t8kMFa6wvuthTR5By7k35osepUrwu257` |

The devnet program is still upgradeable so the public test can lead to fixes. The upgrade authority is removed (`solana program set-upgrade-authority --final`) before mainnet.

## How it works

| T.I.M.E. (PulseChain) | Klepsydra (Solana) |
|---|---|
| `receive()`: PLS sent to the contract | `distribute(amount)`, or plain SOL sent to the `config` PDA |
| `magnifiedDividendPerShare` (×2^128) | `mag_per_share` (×2^64, u64 amounts) |
| `_beforeTokenTransfer` updates corrections | the Token-2022 transfer hook updates corrections |
| `claimDividend(recipient, amount)` | `claim(amount)` to any recipient |
| ownership renounced | no admin, checked on-chain by `initialize` |

A holder's accrued SOL is `(mag_per_share × last_balance + correction) / 2^64 − claimed`.

### Changes from T.I.M.E.

1. **Opt-in (`register`).** Only token accounts whose owner signed `register` share in payments. DEX pools and other program-owned accounts cannot register, so no dividend gets stuck in them.
2. **No rounding loss.** The remainder of each division (`carry`) is added to the next payment.
3. **Plain transfers count.** SOL sent straight to the `config` PDA is split by the next `distribute(0)`, which anyone can call.
4. **No admin, enforced in code.** `initialize` refuses a mint that has a mint authority, freeze authority, transfer-hook authority, permanent delegate, transfer fee, default-frozen accounts, interest, confidential transfers, pause or a close authority.
5. **Burn-safe.** Token-2022 does not call the hook on burn, so the program stores `last_balance` and resyncs on every operation. Burned tokens stop earning; SOL accrued before the burn stays claimable.
6. **Partial claims, claims to another address, `unregister`** (pays out everything, leaves the split, refunds the ~0.0015 SOL record rent).

## Instructions

| Instruction | Who | What it does |
|---|---|---|
| `initialize` | once, anyone | creates `config` and the hook's extra-account list; verifies the mint |
| `register` | token account owner | joins the split from now on |
| `distribute(amount)` | anyone | pays in `amount` lamports and splits all undistributed SOL |
| `claim(amount)` | token account owner | pays out `amount` (0 = all) to the given recipient |
| `unregister` | token account owner | pays out everything, leaves, refunds rent |
| `transfer_hook` | Token-2022 only | updates corrections on each transfer; rejected if called directly |

PDAs: `config = ["config", mint]`, `holder = ["holder", token_account]`, `extra-account-metas = ["extra-account-metas", mint]`.

Clients must pass the hook's extra accounts on transfers. `createTransferCheckedWithTransferHookInstruction` from `@solana/spl-token` does this.

Where the token can trade: Raydium CPMM accepts Token-2022 mints with an active transfer hook (its `SwapV2` forwards the hook accounts). Meteora DAMM v2 does not: it accepts a hook only when both the hook program and authority are unset. Meteora DBC revokes the hook when the bonding curve completes, which would switch the dividend off, so it is not a launch path for this token.

## Build

Rust, Solana CLI 2.x and Anchor 0.31.1 (Linux or WSL).

```bash
anchor build
```

The Solana platform tools ship cargo 1.84, so `Cargo.lock` was generated with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback` and `blake3` pinned to 1.5.5. A verifiable build (`solana-verify`) that proves the deployed binary matches this source is planned before mainnet.

## Tests

`tests/` holds the scripts and `tests/results/` the logs of the runs on 2026-10-19.

| Script | What it checks | Result |
|---|---|---|
| `devnet-test.mjs` | full cycle and negative cases on `solana-test-validator` | 14/14 |
| `devnet-test-slow.mjs` | the same cycle on public devnet, throttled for the public RPC | 14/14 |
| `streamflow-hook-test.mjs` | Streamflow vesting contracts moving $KLEPS through the hook | 9/9 |
| `create-devnet-mint.mjs` | creates the test mint, removes its authorities, runs `initialize` | — |

```bash
npm install
RPC_URL=https://api.devnet.solana.com node tests/devnet-test-slow.mjs
```

The scripts read the payer keypair from `~/.config/solana/id.json`. Log text is in Polish.

`idl/time_dividend.json` is the Anchor IDL. The crate is still named `time_dividend` after the model it follows.

## Known limits

- **Payouts depend on SOL coming in.** Without income the dividend is zero. Nothing here guarantees any amount.
- **Sandwiching a payment:** someone can buy just before a large `distribute` and sell right after, as with T.I.M.E. A streamed payout (spreading each payment over time) is being considered.
- A token account that receives tokens but never registers earns nothing. This is deliberate (see change 1).
- Dividends are paid in SOL only.
- **Not audited.** Do not rely on this code with funds you cannot afford to lose.

## Licence

MIT, see [LICENSE](LICENSE).

---

**PL:** Program Anchor dla Solany (Token-2022 z transfer hookiem). Posiadacze tokena dzielą się SOL wpłacanym do programu proporcjonalnie do salda, na wzór T.I.M.E. Dividend z PulseChain. Stan: publiczny test na devnecie, bez audytu, token na mainnecie jeszcze nie istnieje. Szczegóły i weryfikacja na żywo: [kleps.io/pl/token](https://kleps.io/pl/token/).
