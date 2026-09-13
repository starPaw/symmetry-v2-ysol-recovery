# Technical Notes

This document records the recovery investigation that led to the public tool.

## Observed failure chain

The legacy YSOL position was still represented by a valid SPL token balance, but the historical client path no longer worked.

1. Legacy SDK initialization failed because it called the obsolete Jupiter endpoint `https://token.jup.ag/strict`.
2. After bypassing that metadata request, legacy `SellFund` reached the program but failed with `AccountNotEnoughKeys` / error 3005 on `seed_pubkey`.
3. The current on-chain IDL showed that `SellFund` now expects a tenth account named `seedPubkey`.
4. A successful modern mainnet `SellFund` transaction used:
   ```text
   newFundState:
   2LcrP1yjPsysbRuhGNbY9FzvKwG145UodtQLRRfPgxxw

   seedPubkey:
   tcFmVf9kBvuZ2GbDZU7swxqowbHYB7VKD7VzwJu3EZB
   ```
5. Passing the tenth account while still using a normal random `newFundState` produced `ConstraintSeeds` / error 2006.
6. The PDA relationship was reconstructed and verified:
   ```javascript
   PublicKey.findProgramAddressSync(
     [Buffer.from("sell"), seedPubkey.toBuffer()],
     programId
   );
   ```
7. Using a fresh `seedPubkey` and the derived PDA made `SellFund` simulate successfully.
8. The current IDL also showed that `ClaimToken` gained a new first account named `signer`.
9. Prepending the wallet as `signer` to each legacy claim instruction produced a complete successful atomic simulation.
10. The final claim emitted `TXINFO:ClosedSellState`.

## InstantBurn vs proportional redemption

`InstantBurn` returned:

```text
ProgramFrozen
Error Number: 6036
Program is frozen. Contact developer support.
```

But the proportional path behaved differently:

```text
InstantBurn        -> ProgramFrozen
SellFund           -> succeeds
ClaimToken         -> succeeds
Close SellState    -> succeeds
```

That distinction is the key discovery behind this recovery.

## Account layout changes

### Legacy SellFund

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

### Current SellFund

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
9 seedPubkey
```

The old SDK also creates `newFundState` as a normal Keypair-backed account. The deployed program expects a PDA derived from `["sell", seedPubkey]`.

### Legacy ClaimToken

```text
0 manager
1 fundState
2 tokenList
3 sellerTokenAccount
4 pdaTokenAccount
5 pdaAccount
6 systemProgram
7 tokenProgram
```

### Current ClaimToken

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

For this SellState redemption path, the selling wallet is used as both `signer` and `manager`.

## Why atomic execution is preferable

The old SDK treats selling and claiming as separate operations. The tested legacy YSOL fund only had three underlying assets, so all instructions fit into one Solana transaction.

Observed simulation characteristics:

```text
serialized transaction size: 851 bytes
compute units consumed:      ~189,598
```

That allowed `SellFund + Claim USDC + Claim JitoSOL + Claim mSOL + Close SellState` to execute atomically. If any instruction fails, the YSOL burn rolls back too.

## Temporary rent

The observed SellState rent requirement was:

```text
52,506,880 lamports
0.05250688 SOL
```

The account closes on the final claim and its rent is returned, but the wallet needs enough SOL to fund it during execution.

## External swap path

Jupiter returned `Failed to get quotes`, and no useful DEX pair was found during the investigation. The recovery tool therefore uses Symmetry's on-chain redemption path rather than relying on external YSOL liquidity.

## Limitations

- This investigation focused on one legacy YSOL fund.
- Other Symmetry V2 funds may behave differently.
- Larger fund compositions may not fit in one transaction.
- Program upgrades can change behavior after publication.
- Simulation success is not a guarantee of future execution success.
- This is not an official Symmetry migration tool.

Always inspect the code and simulate against current mainnet state before execution.
