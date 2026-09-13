import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { FundsSDK } from "@symmetry-hq/funds-sdk";

const require = createRequire(import.meta.url);
const BN = require("bn.js");
const config = require(
  "./node_modules/@symmetry-hq/funds-sdk/dist/config.js"
);

const EXECUTE = process.argv.includes("--execute");

const EXPECTED_PROGRAM = new PublicKey(
  "2KehYt3KsEQR53jYcxjbQp2d2kCp4AkuQW68atufRwSr"
);

const FUND = new PublicKey(
  process.env.FUND_ADDRESS ||
  "4RofqKG4d6jfUD2HjtWb2F9UkLJvJ7P3kFmyuhX7H88d"
);

const YSOL = new PublicKey(
  process.env.YSOL_MINT ||
  "3htQDAvEx53jyMJ2FVHeztM5BRjfmNuBqceXu1fJRqWx"
);

// Known successful modern SellFund relationship.
// Used only to verify the PDA derivation rule.
const KNOWN_SEED = new PublicKey(
  "tcFmVf9kBvuZ2GbDZU7swxqowbHYB7VKD7VzwJu3EZB"
);

const KNOWN_SELL_STATE = new PublicKey(
  "2LcrP1yjPsysbRuhGNbY9FzvKwG145UodtQLRRfPgxxw"
);

function section(title) {
  console.log("\n====================================");
  console.log(title);
  console.log("====================================");
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function solanaConfig() {
  const output = execFileSync(
    "solana",
    ["config", "get"],
    { encoding: "utf8" }
  );

  const rpc = output.match(
    /^RPC URL:\s*(.+)$/m
  )?.[1]?.trim();

  const keypair = output.match(
    /^(?:Keypair Path|Default Signer Path):\s*(.+)$/m
  )?.[1]?.trim();

  return {
    rpc,
    keypair: expandHome(keypair),
  };
}

function loadKeypair(filename) {
  const secret = JSON.parse(
    fs.readFileSync(filename, "utf8")
  );

  return Keypair.fromSecretKey(
    Uint8Array.from(secret)
  );
}

function walletFromKeypair(keypair) {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,

    async signTransaction(tx) {
      tx.partialSign(keypair);
      return tx;
    },

    async signAllTransactions(txs) {
      return txs.map(tx => {
        tx.partialSign(keypair);
        return tx;
      });
    },
  };
}

function decodeName(value) {
  if (!value) return "";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    const zero = value.indexOf(0);
    const bytes =
      zero === -1
        ? value
        : value.slice(0, zero);

    return Buffer
      .from(bytes)
      .toString("utf8");
  }

  return String(value);
}

function formatRaw(raw, decimals) {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const fraction = n % base;

  if (fraction === 0n) {
    return whole.toString();
  }

  return (
    whole.toString() +
    "." +
    fraction
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "")
  );
}

async function tokenBalanceSafe(
  connection,
  ata
) {
  try {
    return (
      await connection.getTokenAccountBalance(
        ata,
        "confirmed"
      )
    ).value;
  } catch {
    return null;
  }
}

async function main() {
  section(
    EXECUTE
      ? "SYMMETRY V2 YSOL RECOVERY — EXECUTE MODE"
      : "SYMMETRY V2 YSOL RECOVERY — SIMULATION ONLY"
  );

  const cli = solanaConfig();

  const rpc =
    process.env.RPC_URL ||
    cli.rpc ||
    "https://api.mainnet-beta.solana.com";

  const keypairPath =
    expandHome(
      process.env.KEYPAIR ||
      cli.keypair ||
      "~/.config/solana/id.json"
    );

  const signer = loadKeypair(keypairPath);
  const owner = signer.publicKey;

  console.log("\nRPC:", rpc);
  console.log("Keypair:", keypairPath);
  console.log("Wallet:", owner.toBase58());
  console.log("Fund:", FUND.toBase58());
  console.log("Expected YSOL mint:", YSOL.toBase58());

  const connection =
    new Connection(rpc, "confirmed");

  const wallet =
    walletFromKeypair(signer);

  const solBefore =
    await connection.getBalance(
      owner,
      "confirmed"
    );

  console.log(
    "SOL:",
    solBefore / 1e9
  );

  console.log(
    "\nInitializing legacy Symmetry SDK..."
  );

  const sdk =
    await FundsSDK.init(
      connection,
      wallet
    );

  const fund =
    await sdk.loadFromPubkey(
      FUND
    );

  const programId =
    sdk.program.programId;

  console.log(
    "Program:",
    programId.toBase58()
  );

  if (!programId.equals(EXPECTED_PROGRAM)) {
    throw new Error(
      [
        "Unexpected Symmetry program — ABORT.",
        `Expected: ${EXPECTED_PROGRAM.toBase58()}`,
        `Actual:   ${programId.toBase58()}`,
      ].join("\n")
    );
  }

  if (!fund.data.fundToken.equals(YSOL)) {
    throw new Error(
      [
        "Fund mint does not match expected YSOL mint — ABORT.",
        `Expected: ${YSOL.toBase58()}`,
        `Actual:   ${fund.data.fundToken.toBase58()}`,
      ].join("\n")
    );
  }

  section("VERIFY SELLSTATE PDA RULE");

  const [knownDerived, knownBump] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("sell"),
        KNOWN_SEED.toBuffer(),
      ],
      programId
    );

  console.log(
    "\nKnown seed:",
    KNOWN_SEED.toBase58()
  );

  console.log(
    "Expected SellState:",
    KNOWN_SELL_STATE.toBase58()
  );

  console.log(
    "Derived SellState:",
    knownDerived.toBase58()
  );

  console.log(
    "Bump:",
    knownBump
  );

  if (
    !knownDerived.equals(
      KNOWN_SELL_STATE
    )
  ) {
    throw new Error(
      "PDA derivation verification failed — ABORT."
    );
  }

  console.log("PDA rule: OK");

  const ysolAta =
    getAssociatedTokenAddressSync(
      YSOL,
      owner
    );

  const ysolAtaInfo =
    await connection.getAccountInfo(
      ysolAta,
      "confirmed"
    );

  if (!ysolAtaInfo) {
    throw new Error(
      "No YSOL associated token account found."
    );
  }

  const ysolBalance =
    await connection.getTokenAccountBalance(
      ysolAta,
      "confirmed"
    );

  const burnRaw =
    ysolBalance.value.amount;

  section("YSOL BALANCE");

  console.log(
    "\nATA:",
    ysolAta.toBase58()
  );

  console.log(
    "Raw:",
    burnRaw
  );

  console.log(
    "UI:",
    ysolBalance.value.uiAmountString
  );

  if (BigInt(burnRaw) === 0n) {
    throw new Error(
      "YSOL balance is zero."
    );
  }

  // The public key is used only as PDA entropy.
  // The corresponding private key is not used.
  const seedPubkey =
    Keypair.generate().publicKey;

  const [sellState, sellBump] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("sell"),
        seedPubkey.toBuffer(),
      ],
      programId
    );

  section("TEMPORARY SELL STATE");

  console.log(
    "\nseedPubkey:",
    seedPubkey.toBase58()
  );

  console.log(
    "SellState PDA:",
    sellState.toBase58()
  );

  console.log(
    "Bump:",
    sellBump
  );

  if (
    await connection.getAccountInfo(
      sellState,
      "confirmed"
    )
  ) {
    throw new Error(
      "Generated SellState already exists — ABORT."
    );
  }

  const tokenList =
    sdk.tokenList;

  const tokenCount =
    fund.data.numOfTokens.toNumber();

  const composition = [];

  section("FUND COMPOSITION");

  for (
    let i = 0;
    i < tokenCount;
    i++
  ) {
    const tokenId =
      fund.data.currentCompToken[i]
        .toNumber();

    const settings =
      tokenList[tokenId];

    if (!settings) {
      throw new Error(
        `Missing TokenList entry for id ${tokenId}`
      );
    }

    const mint =
      new PublicKey(
        settings.tokenMint
      );

    const decimals =
      settings.decimals;

    const name =
      decodeName(
        settings.coingeckoId
      ) ||
      mint.toBase58();

    const fundAmountRaw =
      BigInt(
        fund.data.currentCompAmount[i]
          .toString()
      );

    const userAta =
      getAssociatedTokenAddressSync(
        mint,
        owner
      );

    const ataExists =
      Boolean(
        await connection.getAccountInfo(
          userAta,
          "confirmed"
        )
      );

    const pdaTokenAccount =
      new PublicKey(
        settings.pdaTokenAccount
      );

    composition.push({
      index: i,
      tokenId,
      mint,
      decimals,
      name,
      fundAmountRaw,
      userAta,
      ataExists,
      pdaTokenAccount,
    });

    console.log(
      `\n#${i} ${name}`
    );

    console.log(
      "tokenId:",
      tokenId
    );

    console.log(
      "mint:",
      mint.toBase58()
    );

    console.log(
      "fund amount:",
      formatRaw(
        fundAmountRaw,
        decimals
      )
    );

    console.log(
      "user ATA:",
      userAta.toBase58()
    );

    console.log(
      "ATA exists:",
      ataExists
    );
  }

  const beforeBalances =
    new Map();

  for (const token of composition) {
    beforeBalances.set(
      token.mint.toBase58(),
      await tokenBalanceSafe(
        connection,
        token.userAta
      )
    );
  }

  const supplyField =
    fund.data.supplyOutsanding ??
    fund.data.supplyOutstanding ??
    fund.data.currentSupply;

  if (supplyField) {
    const supplyRaw =
      BigInt(
        supplyField.toString()
      );

    section("PROPORTIONAL ESTIMATE");

    for (const token of composition) {
      const estimate =
        (
          token.fundAmountRaw *
          BigInt(burnRaw)
        ) /
        supplyRaw;

      console.log(
        `${token.name}: ${formatRaw(
          estimate,
          token.decimals
        )}`
      );
    }
  }

  section("BUILD SELLFUND");

  const sellIx =
    await sdk.program.methods
      .sellFund(
        new BN(burnRaw),
        new BN(0)
      )
      .accounts({
        seller:
          owner,

        fundState:
          FUND,

        pdaAccount:
          config.FUNDS_PROGRAM_PDA,

        newFundState:
          sellState,

        sellerFundTokenAccount:
          ysolAta,

        fundToken:
          YSOL,

        systemProgram:
          SystemProgram.programId,

        tokenProgram:
          TOKEN_PROGRAM_ID,

        rent:
          SYSVAR_RENT_PUBKEY,
      })
      .instruction();

  console.log(
    "\nLegacy SellFund keys:",
    sellIx.keys.length
  );

  if (sellIx.keys.length !== 9) {
    throw new Error(
      `Expected 9 legacy SellFund accounts, got ${sellIx.keys.length}`
    );
  }

  // Current deployed program expects seedPubkey as account #10.
  sellIx.keys.push({
    pubkey:
      seedPubkey,

    isSigner:
      false,

    isWritable:
      false,
  });

  console.log(
    "Patched SellFund keys:",
    sellIx.keys.length
  );

  if (sellIx.keys.length !== 10) {
    throw new Error(
      "SellFund account patch failed."
    );
  }

  const tx =
    new Transaction();

  tx.add(
    ComputeBudgetProgram
      .setComputeUnitLimit({
        units: 1_000_000,
      })
  );

  tx.add(
    ComputeBudgetProgram
      .setComputeUnitPrice({
        microLamports: 25_000,
      })
  );

  section("TOKEN ACCOUNTS");

  let createdAtaCount = 0;

  for (const token of composition) {
    if (token.ataExists) {
      console.log(
        `${token.name}: exists`
      );
      continue;
    }

    console.log(
      `${token.name}: CREATE`
    );

    tx.add(
      createAssociatedTokenAccountInstruction(
        owner,
        token.userAta,
        owner,
        token.mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    createdAtaCount++;
  }

  console.log(
    "\nMissing ATAs:",
    createdAtaCount
  );

  tx.add(sellIx);

  section("BUILD CLAIMS");

  let claimCount = 0;

  for (const token of composition) {
    if (
      token.fundAmountRaw === 0n &&
      token.index !== 0
    ) {
      console.log(
        `${token.name}: skipped`
      );
      continue;
    }

    const claimIx =
      await sdk.program.methods
        .claimToken(
          new BN(token.tokenId)
        )
        .accounts({
          manager:
            owner,

          fundState:
            sellState,

          tokenList:
            config.TOKEN_LIST_ADDRESS,

          sellerTokenAccount:
            token.userAta,

          pdaTokenAccount:
            token.pdaTokenAccount,

          pdaAccount:
            config.FUNDS_PROGRAM_PDA,

          systemProgram:
            SystemProgram.programId,

          tokenProgram:
            TOKEN_PROGRAM_ID,
        })
        .instruction();

    if (claimIx.keys.length !== 8) {
      throw new Error(
        `Expected 8 legacy ClaimToken accounts, got ${claimIx.keys.length}`
      );
    }

    // Current program expects signer as the new first account.
    claimIx.keys.unshift({
      pubkey:
        owner,

      isSigner:
        true,

      isWritable:
        true,
    });

    if (claimIx.keys.length !== 9) {
      throw new Error(
        "ClaimToken account patch failed."
      );
    }

    console.log(
      `${token.name}: 9 accounts`
    );

    tx.add(claimIx);
    claimCount++;
  }

  console.log(
    "\nClaims:",
    claimCount
  );

  if (claimCount === 0) {
    throw new Error(
      "No claims were built — ABORT."
    );
  }

  section("TRANSACTION SANITY");

  const simulationBlockhash =
    await connection.getLatestBlockhash(
      "confirmed"
    );

  tx.feePayer = owner;
  tx.recentBlockhash =
    simulationBlockhash.blockhash;

  tx.sign(signer);

  const serialized =
    tx.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    });

  console.log(
    "\nInstruction count:",
    tx.instructions.length
  );

  console.log(
    "Serialized size:",
    serialized.length,
    "bytes"
  );

  if (serialized.length > 1232) {
    throw new Error(
      `Transaction too large: ${serialized.length} bytes`
    );
  }

  section("SIMULATING ATOMIC WITHDRAWAL");

  const simulation =
    await connection.simulateTransaction(
      tx,
      [signer]
    );

  console.log(
    "\nSimulation error:"
  );

  console.dir(
    simulation.value.err,
    { depth: null }
  );

  console.log(
    "\nUnits consumed:",
    simulation.value.unitsConsumed
  );

  const logs =
    simulation.value.logs ?? [];

  console.log("\nLogs:");

  for (const line of logs) {
    console.log(line);
  }

  if (simulation.value.err !== null) {
    throw new Error(
      "Simulation failed. Transaction WILL NOT be sent."
    );
  }

  const expectedBurn =
    `TXINFO:BurnAmount:${YSOL.toBase58()}:${burnRaw}`;

  if (
    !logs.some(
      line =>
        line.includes(expectedBurn)
    )
  ) {
    throw new Error(
      "Expected YSOL burn log was not observed — ABORT."
    );
  }

  const observedClaims =
    logs.filter(
      line =>
        line.includes(
          "Instruction: ClaimToken"
        )
    ).length;

  if (observedClaims !== claimCount) {
    throw new Error(
      [
        "Unexpected ClaimToken count — ABORT.",
        `Built: ${claimCount}`,
        `Observed: ${observedClaims}`,
      ].join("\n")
    );
  }

  if (
    !logs.some(
      line =>
        line.includes(
          "TXINFO:ClosedSellState"
        )
    )
  ) {
    throw new Error(
      "SellState did not close in simulation — ABORT."
    );
  }

  section("SIMULATION PASSED");

  console.log(
    "\nSellFund succeeded."
  );

  console.log(
    `${observedClaims} ClaimToken instructions succeeded.`
  );

  console.log(
    "SellState closed."
  );

  console.log(
    "Verified YSOL burn raw amount:",
    burnRaw
  );

  if (!EXECUTE) {
    console.log(
      "\nSIMULATION ONLY."
    );

    console.log(
      "NOTHING WAS SENT."
    );

    console.log(
      "NO YSOL WAS BURNED."
    );

    console.log(
      "\nTo execute after reviewing this output:"
    );

    console.log(
      "node withdraw-ysol-atomic.mjs --execute"
    );

    return;
  }

  section("PRE-EXECUTION CHECKS");

  const liveYsol =
    await connection.getTokenAccountBalance(
      ysolAta,
      "confirmed"
    );

  console.log(
    "\nSimulated YSOL raw:",
    burnRaw
  );

  console.log(
    "Current YSOL raw:",
    liveYsol.value.amount
  );

  if (
    liveYsol.value.amount !== burnRaw
  ) {
    throw new Error(
      "YSOL balance changed after simulation — ABORT."
    );
  }

  if (
    await connection.getAccountInfo(
      sellState,
      "confirmed"
    )
  ) {
    throw new Error(
      "SellState appeared after simulation — ABORT."
    );
  }

  console.log(
    "Pre-execution checks: OK"
  );

  section("EXECUTING REAL ATOMIC WITHDRAWAL");

  const executionBlockhash =
    await connection.getLatestBlockhash(
      "confirmed"
    );

  tx.recentBlockhash =
    executionBlockhash.blockhash;

  tx.feePayer =
    owner;

  tx.sign(signer);

  const rawTransaction =
    tx.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    });

  const signature =
    await connection.sendRawTransaction(
      rawTransaction,
      {
        skipPreflight: false,
        maxRetries: 5,
      }
    );

  console.log(
    "\nSignature:",
    signature
  );

  console.log(
    "Explorer:",
    `https://solscan.io/tx/${signature}`
  );

  const confirmation =
    await connection.confirmTransaction(
      {
        signature,
        blockhash:
          executionBlockhash.blockhash,
        lastValidBlockHeight:
          executionBlockhash
            .lastValidBlockHeight,
      },
      "confirmed"
    );

  if (confirmation.value.err) {
    console.dir(
      confirmation.value.err,
      { depth: null }
    );

    throw new Error(
      "Transaction was confirmed with an error."
    );
  }

  section("WITHDRAWAL CONFIRMED");

  await new Promise(
    resolve =>
      setTimeout(resolve, 2000)
  );

  const ysolAfter =
    await tokenBalanceSafe(
      connection,
      ysolAta
    );

  console.log(
    "\nYSOL before:",
    ysolBalance.value.uiAmountString
  );

  console.log(
    "YSOL after:",
    ysolAfter
      ? ysolAfter.uiAmountString
      : "unavailable"
  );

  for (const token of composition) {
    const before =
      beforeBalances.get(
        token.mint.toBase58()
      );

    const after =
      await tokenBalanceSafe(
        connection,
        token.userAta
      );

    console.log(
      `\n${token.name}`
    );

    console.log(
      "before:",
      before
        ? before.uiAmountString
        : "0 / unavailable"
    );

    console.log(
      "after:",
      after
        ? after.uiAmountString
        : "unavailable"
    );

    if (before && after) {
      const deltaRaw =
        BigInt(after.amount) -
        BigInt(before.amount);

      console.log(
        "received:",
        formatRaw(
          deltaRaw,
          token.decimals
        )
      );
    }
  }

  const solAfter =
    await connection.getBalance(
      owner,
      "confirmed"
    );

  console.log(
    "\nSOL before:",
    solBefore / 1e9
  );

  console.log(
    "SOL after:",
    solAfter / 1e9
  );

  console.log(
    "\nDone."
  );
}

main().catch(error => {
  console.error("\nFATAL:");
  console.error(error);
  process.exit(1);
});
