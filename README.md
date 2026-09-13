# Symmetry V2 YSOL Recovery

A recovery tool and technical write-up for legacy **Symmetry V2 YSOL** positions on Solana.

This repository documents a compatibility break between the published legacy `@symmetry-hq/funds-sdk` and the currently deployed Symmetry V2 program, and provides an **atomic, simulation-first** redemption flow for the legacy YSOL fund.

> [!WARNING]
> This is experimental recovery software and is **not affiliated with Symmetry**.
> The default mode is simulation-only. Nothing is submitted unless you explicitly run with `--execute`.
> Read the source, verify every address, and never share your seed phrase or private key.

## Known legacy YSOL addresses

```text
Symmetry V2 program:
2KehYt3KsEQR53jYcxjbQp2d2kCp4AkuQW68atufRwSr

YSOL mint:
3htQDAvEx53jyMJ2FVHeztM5BRjfmNuBqceXu1fJRqWx

YSOL fund:
4RofqKG4d6jfUD2HjtWb2F9UkLJvJ7P3kFmyuhX7H88d
```

At the time of investigation the fund held USDC, JitoSOL, and mSOL.

## What broke

### 1. Dead Jupiter token-list endpoint

The legacy SDK calls:

```text
https://token.jup.ag/strict
```

That endpoint is no longer usable. In this SDK path it only enriches token metadata; the critical Symmetry token configuration still comes from the on-chain TokenList account. This repo includes a post-install patch that bypasses the obsolete request.

### 2. `SellFund` account layout changed

The legacy SDK builds `SellFund` with 9 accounts:

```text
0 seller
1 fundState
2 pdaAccount
3 newFundState
4 sellerFundTokenAccount
5 fundToken
6 systemProgram
7 tokenProgram
8 rent
```

The deployed program currently expects one more:

```text
9 seedPubkey
```

Using the old SDK layout directly produces:

```text
AccountNotEnoughKeys
Error Number: 3005
account: seed_pubkey
```

### 3. `newFundState` is now a PDA

The legacy SDK creates a random keypair account for the temporary sell state. The deployed program instead validates:

```javascript
const [newFundState] = PublicKey.findProgramAddressSync(
  [Buffer.from("sell"), seedPubkey.toBuffer()],
  programId
);
```

The `seedPubkey` does not need to exist on-chain and is not a signer. It can be a fresh public key used only as PDA entropy.

Supplying a normal random account produces:

```text
ConstraintSeeds
Error Number: 2006
```

### 4. `ClaimToken` also changed

The legacy SDK creates `ClaimToken` with 8 accounts. The deployed program expects a new first account:

```text
0 signer
1 manager
2 fundState
3 tokenList
4 sellerTokenAccount
5 pdaTokenAccount
6 pdaAccount
7 systemProgram
8 tokenProgram
```

For a SellState redemption, the selling wallet is used for both `signer` and `manager`.

### 5. `InstantBurn` can be frozen while proportional redemption still works

The legacy `InstantBurn` path returned:

```text
ProgramFrozen
Error Number: 6036
Program is frozen. Contact developer support.
```

However, the proportional `SellFund -> ClaimToken` path still simulated successfully. A `ProgramFrozen` error on `InstantBurn` therefore does **not necessarily mean all redemption paths are disabled**.

## Recovery strategy

The tool constructs one atomic transaction:

```text
YSOL
  |
  v
SellFund
  |
  v
temporary SellState PDA
  |
  +--> Claim USDC
  +--> Claim JitoSOL
  +--> Claim mSOL
  |
  v
Close SellState
```

If any instruction fails, the entire Solana transaction rolls back.

## Verified simulation example

One mainnet-state simulation redeemed:

```text
0.038227 YSOL
```

into approximately:

```text
0.013555 USDC
0.068379074 JitoSOL
0.063546669 mSOL
```

The logs included:

```text
Instruction: SellFund
TXINFO:SellStateCreated:...
TXINFO:BurnAmount:...:38227

Instruction: ClaimToken
TXINFO:AmountClaimed:0:13555

Instruction: ClaimToken
TXINFO:AmountClaimed:6:68379074

Instruction: ClaimToken
TXINFO:AmountClaimed:5:63546669
TXINFO:ClosedSellState
```

with:

```text
Simulation error: null
```

These values are only an example from one point in time.

## Temporary SOL requirement

During the investigation, the temporary SellState required:

```text
52,506,880 lamports
0.05250688 SOL
```

The rent is returned when the SellState closes, but the wallet must have enough SOL to create it first, plus fees. Missing associated token accounts can require additional rent.

## Requirements

- Node.js 20+
- Solana CLI
- a locally configured Solana keypair
- enough SOL for temporary rent and fees

Check your signer:

```bash
solana config get
solana address
solana balance
```

## Install

```bash
git clone https://github.com/starPaw/symmetry-v2-ysol-recovery.git
cd symmetry-v2-ysol-recovery
npm install
```

The post-install step patches the obsolete Jupiter token-list request inside the legacy SDK.

## Simulate first

```bash
node withdraw-ysol-atomic.mjs
```

A healthy run should end with output similar to:

```text
SIMULATION PASSED

SellFund succeeded.
3 ClaimToken instructions succeeded.
SellState closed.

SIMULATION ONLY.
NOTHING WAS SENT.
NO YSOL WAS BURNED.
```

If simulation fails, do not execute.

## Execute

Only after reviewing a successful simulation:

```bash
node withdraw-ysol-atomic.mjs --execute
```

Execution mode simulates first, verifies the burn amount and claim count, checks that the SellState closes, re-checks wallet state, refreshes the blockhash, signs locally, and submits with RPC preflight enabled.

## Optional environment variables

```bash
RPC_URL=https://your-rpc.example
KEYPAIR=~/.config/solana/id.json
FUND_ADDRESS=4RofqKG4d6jfUD2HjtWb2F9UkLJvJ7P3kFmyuhX7H88d
YSOL_MINT=3htQDAvEx53jyMJ2FVHeztM5BRjfmNuBqceXu1fJRqWx
node withdraw-ysol-atomic.mjs
```

## Troubleshooting

| Error | Meaning |
|---|---|
| `AccountNotEnoughKeys / 3005` on `seed_pubkey` | Old 9-account `SellFund` layout |
| `ConstraintSeeds / 2006` on `new_fund_state` | `newFundState` is not `PDA(["sell", seedPubkey])` |
| `ProgramFrozen / 6036` on `InstantBurn` | Instant redemption is frozen; proportional redemption may still work |
| insufficient lamports | Wallet cannot fund the temporary SellState rent and fees |
| Jupiter `Failed to get quotes` | No usable external YSOL route was found; redeem through Symmetry instead |

## Scope

This tool is intentionally scoped to the known legacy YSOL fund. The compatibility technique may apply to other Symmetry V2 funds, but they have not been validated here.

## Security

- Never paste a seed phrase or private key into an issue, chat, website, or support ticket.
- The script reads the local Solana CLI keypair.
- Verify `solana address` before execution.
- Audit the source before using `--execute`.
- Programs and on-chain state can change.

See [docs/technical-notes.md](docs/technical-notes.md) for the investigation details.

## Disclaimer

This software is provided as-is, without warranty. Use it at your own risk.

This project is not affiliated with Symmetry, Jupiter, Marinade, Jito, the Solana Foundation, or Solana Labs.
