import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  CU_BUY, CU_COLLECT, CU_CREATE, CU_DISTRIBUTE, CU_SWEEP, CU_TRANSFER,
  DEFAULT_PRIORITY_MICROLAMPORTS,
  LAMPORTS_PER_SIGNATURE,
  RENT_EXEMPT_MIN_LAMPORTS,
} from './constants.js';
import { fetchTipAccounts, pickTipAccount, sendBundle, tipInstruction } from './jito.js';
import {
  buildSignedTx, computeBudgetInstructions, confirmSignatures, fitsInTransaction, signatureOf, simulateOrThrow,
} from './tx.js';

/**
 * A plan is a list of transactions to land atomically in one Jito bundle,
 * plus a human-readable summary the UI shows before anything is signed.
 * Nothing in a plan is signed or sent until `executePlan` runs.
 */

const same = (a, b) => a.publicKey.toBase58() === b.publicKey.toBase58();
const dedupeSigners = (list) => [...new Map(list.map((k) => [k.publicKey.toBase58(), k])).values()];
/** A zero tip means "this tx rides in a bundle whose first tx already tipped". */
const maybeTip = (payer, tipAccount, lamports) => (lamports > 0 ? [tipInstruction(payer, tipAccount, lamports)] : []);
const sumLamports = (rows) => rows.reduce((total, r) => total + r.lamports, 0);
const describeSweep = ({ venue, mint, address, lamports }) => ({ venue, mint, address, lamports });

/** What a transaction costs its fee payer: the base fee per signature plus the priority fee on its CU limit. */
export function networkFeeLamports({ units, signatures = 1, priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS }) {
  return LAMPORTS_PER_SIGNATURE * signatures + Math.ceil((units * priorityMicroLamports) / 1_000_000);
}

/**
 * Launch a coin. If `funder` and `creator` are the same keypair it is one
 * transaction; otherwise Tx1 (funder) forwards rent + dev buy + tip and Tx2
 * (creator) runs createV2, so the creator wallet needs zero SOL beforehand.
 */
export function planLaunch({
  funder, creator, mint, createInstructions, lookupTables = [],
  devBuyLamports = 0, rentLamports, tipLamports, tipAccount,
  priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS,
}) {
  const units = CU_CREATE + (devBuyLamports > 0 ? CU_BUY : 0);
  const tip = maybeTip(funder.publicKey, tipAccount, tipLamports);
  const summary = {
    kind: 'launch',
    mint: mint.publicKey.toBase58(),
    funder: funder.publicKey.toBase58(),
    creator: creator.publicKey.toBase58(),
    devBuyLamports,
    tipLamports,
    rentLamports,
  };

  if (same(funder, creator)) {
    return {
      summary: { ...summary, mode: 'single', totalLamports: devBuyLamports + tipLamports + rentLamports },
      txs: [{
        label: 'create',
        payer: funder.publicKey,
        instructions: [...computeBudgetInstructions({ units, priorityMicroLamports }), ...createInstructions, ...tip],
        signers: [funder, mint],
        lookupTables,
        simulate: true,
      }],
    };
  }

  const forwarded = rentLamports + devBuyLamports;
  return {
    summary: { ...summary, mode: 'funded', forwardedLamports: forwarded, totalLamports: forwarded + tipLamports },
    txs: [
      {
        label: 'fund creator + tip',
        payer: funder.publicKey,
        instructions: [
          ...computeBudgetInstructions({ units: CU_TRANSFER, priorityMicroLamports }),
          SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: creator.publicKey, lamports: forwarded }),
          ...tip,
        ],
        signers: [funder],
        simulate: true,
      },
      {
        label: 'create',
        payer: creator.publicKey,
        instructions: [...computeBudgetInstructions({ units, priorityMicroLamports }), ...createInstructions],
        signers: [creator, mint],
        lookupTables,
        simulate: false,
      },
    ],
  };
}

/**
 * Sweep the creator fees still waiting on curves and in pools, collect both vaults and,
 * in the same transaction, move the creator's SOL to `destination`. A leaked creator key
 * never holds a balance a sweeper can take. With `destination` omitted (or equal to the
 * creator) it is a plain claim. Pass the object `buildCollectInstructions` returns.
 *
 * Sweeps go into the claim transaction, largest first, as many as fit. The rest go into
 * sweep-only transactions ahead of it in the bundle (at most `maxTxs` transactions in
 * all); any that still do not fit are left for the next claim and listed in
 * `summary.deferredSweeps`. The claim is simulated on its own only when it does not
 * depend on an earlier transaction in the bundle.
 */
export function planCollect({
  funder, creator, destination = null, collectInstructions,
  vaultLamports, creatorBalanceLamports, tipLamports, tipAccount,
  sweeps = [], unsweepable = [], vaultTopUpLamports = 0, ataRentLamports = 0, unwrapLamports = 0,
  lookupTables = [], maxTxs = 5,
  keepLamports = RENT_EXEMPT_MIN_LAMPORTS, priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS,
}) {
  if (maxTxs < 1) throw new Error('No room left in the bundle for the claim transaction');
  const dest = destination ? new PublicKey(destination) : null;
  const drain = Boolean(dest && !dest.equals(creator.publicKey));
  const creatorPays = same(funder, creator);
  const ordered = [...sweeps].sort((a, b) => b.lamports - a.lamports);
  const tip = maybeTip(funder.publicKey, tipAccount, tipLamports);
  const fits = (instructions) => fitsInTransaction({ payer: funder.publicKey, instructions, lookupTables });

  const claimUnits = (count) => CU_COLLECT + count * CU_SWEEP;
  // A transfer encodes to the same size whatever its amount, so 0 stands in while sizing.
  const claimInstructions = (count, withTip, drainLamports = 0) => [
    ...computeBudgetInstructions({ units: claimUnits(count), priorityMicroLamports }),
    ...(withTip ? tip : []),
    ...ordered.slice(0, count).map((s) => s.instruction),
    ...collectInstructions,
    ...(drain ? [SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: dest, lamports: drainLamports })] : []),
  ];
  const mostThatFit = (from, build) => {
    let count = ordered.length - from;
    while (count > 0 && !fits(build(count))) count--;
    return count;
  };

  let inClaim = mostThatFit(0, (count) => claimInstructions(count, true));
  const tipInClaim = inClaim === ordered.length || maxTxs === 1;
  const sweepTxs = [];
  if (!tipInClaim) {
    // The first sweep-only transaction carries the tip, so the claim leaves at least one sweep to it.
    inClaim = Math.min(mostThatFit(0, (count) => claimInstructions(count, false)), ordered.length - 1);
    let next = inClaim;
    while (next < ordered.length && sweepTxs.length < maxTxs - 1) {
      const from = next;
      const withTip = sweepTxs.length === 0;
      const build = (count) => [
        ...computeBudgetInstructions({ units: count * CU_SWEEP, priorityMicroLamports }),
        ...(withTip ? tip : []),
        ...ordered.slice(from, from + count).map((s) => s.instruction),
      ];
      const count = Math.max(1, mostThatFit(from, build));
      sweepTxs.push({ sweeps: ordered.slice(from, from + count), instructions: build(count), units: count * CU_SWEEP });
      next = from + count;
    }
  }
  const sweptCount = inClaim + sweepTxs.reduce((n, t) => n + t.sweeps.length, 0);
  const included = ordered.slice(0, sweptCount);
  const deferred = ordered.slice(sweptCount);
  const sweptLamports = sumLamports(included);
  // A curve sweep into a vault below its rent floor tops the vault up. Whether the payer or
  // the swept fees cover it, the creator ends up that much short, so it is always reserved.
  const topUp = included.some((s) => s.venue === 'curve') ? vaultTopUpLamports : 0;

  let drainLamports = 0;
  if (drain) {
    const creatorCosts = creatorPays
      ? tipLamports
        + networkFeeLamports({ units: claimUnits(inClaim), priorityMicroLamports })
        + sweepTxs.reduce((total, t) => total + networkFeeLamports({ units: t.units, priorityMicroLamports }), 0)
        + ataRentLamports
      : 0;
    const unwrapped = creatorPays ? 0 : unwrapLamports;
    drainLamports = creatorBalanceLamports + vaultLamports + sweptLamports + unwrapped - keepLamports - creatorCosts - topUp;
    if (drainLamports <= 0) throw new Error('Nothing to move: vault + balance do not cover the rent-exempt buffer');
  }

  return {
    summary: {
      kind: 'collect',
      funder: funder.publicKey.toBase58(),
      creator: creator.publicKey.toBase58(),
      destination: drain ? dest.toBase58() : creator.publicKey.toBase58(),
      vaultLamports,
      sweptLamports,
      claimLamports: vaultLamports + sweptLamports,
      sweeps: included.map(describeSweep),
      deferredSweeps: deferred.map(describeSweep),
      deferredLamports: sumLamports(deferred),
      unsweepable: unsweepable.map(describeSweep),
      vaultTopUpLamports: topUp,
      ataRentLamports,
      drainLamports,
      tipLamports,
      keepLamports: drain ? keepLamports : 0,
    },
    txs: [
      ...sweepTxs.map((t, i) => ({
        label: `sweep creator fees ${i + 1}/${sweepTxs.length}`,
        payer: funder.publicKey,
        instructions: t.instructions,
        signers: [funder],
        lookupTables,
        simulate: true,
      })),
      {
        label: 'collect fees',
        payer: funder.publicKey,
        instructions: claimInstructions(inClaim, tipInClaim, drainLamports),
        signers: dedupeSigners([funder, creator]),
        lookupTables,
        // A drain sized for fees an earlier transaction sweeps would overdraw in a standalone simulation.
        simulate: !(drain && sweepTxs.length > 0),
      },
    ],
  };
}

/** Move the SOL out of a compromised wallet, funder paying fee + tip. */
export function planDrainSol({
  funder, from, destination, balanceLamports, tipLamports, tipAccount,
  keepLamports = 0, priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS,
}) {
  if (same(funder, from)) throw new Error('The funder must be a different wallet from the one being drained');
  const dest = new PublicKey(destination);
  const drainLamports = balanceLamports - keepLamports;
  if (drainLamports <= 0) throw new Error('Wallet balance is already below the amount to keep');
  return {
    summary: {
      kind: 'drain',
      funder: funder.publicKey.toBase58(),
      from: from.publicKey.toBase58(),
      destination: dest.toBase58(),
      drainLamports,
      tipLamports,
    },
    txs: [{
      label: 'drain SOL',
      payer: funder.publicKey,
      instructions: [
        ...computeBudgetInstructions({ units: CU_TRANSFER, priorityMicroLamports }),
        ...maybeTip(funder.publicKey, tipAccount, tipLamports),
        SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: dest, lamports: drainLamports }),
      ],
      signers: [funder, from],
      simulate: true,
    }],
  };
}

/** SPL + Token-2022 balances a wallet holds. */
export async function listTokenAccounts(connection, owner) {
  const ownerPk = new PublicKey(owner);
  const [spl, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const rows = [];
  for (const [program, res] of [[TOKEN_PROGRAM_ID, spl], [TOKEN_2022_PROGRAM_ID, t22]]) {
    for (const { pubkey, account } of res.value) {
      const info = account.data.parsed?.info;
      if (!info) continue;
      const amountRaw = BigInt(info.tokenAmount.amount);
      if (amountRaw === 0n) continue;
      rows.push({
        ata: pubkey.toBase58(),
        mint: info.mint,
        program: program.toBase58(),
        decimals: info.tokenAmount.decimals,
        amountRaw: amountRaw.toString(),
        uiAmount: info.tokenAmount.uiAmountString,
      });
    }
  }
  return rows;
}

/**
 * Move tokens out of a compromised wallet. Up to 3 tokens per transaction
 * (size budget), up to 5 transactions per bundle, all-or-nothing.
 */
export function planRescueTokens({
  funder, from, destinationOwner, tokens, tipLamports, tipAccount,
  priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS,
}) {
  if (!tokens.length) throw new Error('Select at least one token');
  if (tokens.length > 15) throw new Error('At most 15 tokens per rescue bundle');
  const dest = new PublicKey(destinationOwner);
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 3) chunks.push(tokens.slice(i, i + 3));

  const txs = chunks.map((chunk, idx) => {
    const instructions = computeBudgetInstructions({ units: 60_000 * chunk.length, priorityMicroLamports });
    if (idx === 0) instructions.push(...maybeTip(funder.publicKey, tipAccount, tipLamports));
    for (const t of chunk) {
      const mint = new PublicKey(t.mint);
      const program = new PublicKey(t.program);
      const fromAta = getAssociatedTokenAddressSync(mint, from.publicKey, true, program);
      const toAta = getAssociatedTokenAddressSync(mint, dest, true, program);
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, toAta, dest, mint, program, ASSOCIATED_TOKEN_PROGRAM_ID),
        createTransferCheckedInstruction(fromAta, mint, toAta, from.publicKey, BigInt(t.amountRaw), t.decimals, [], program),
      );
    }
    return {
      label: `rescue tokens ${idx + 1}/${chunks.length}`,
      payer: funder.publicKey,
      instructions,
      signers: [funder, from],
      simulate: true,
    };
  });

  return {
    summary: {
      kind: 'rescue-tokens',
      funder: funder.publicKey.toBase58(),
      from: from.publicKey.toBase58(),
      destination: dest.toBase58(),
      tokens: tokens.map((t) => ({ mint: t.mint, amountRaw: t.amountRaw, decimals: t.decimals })),
      tipLamports,
    },
    txs,
  };
}

/**
 * Crank a fee-sharing config: every shareholder gets paid, funder covers fee + tip.
 * `distributeInstructions` come from `buildDistributeInstructions`, whose first
 * `sweepCount` instructions sweep the curve and pool. They stay in the distribute
 * transaction when it fits; otherwise they move to a transaction just ahead of it.
 */
export function planDistribute({
  funder, mint, distributeInstructions, sweepCount = 0, vaultLamports, waitingLamports = 0,
  tipLamports, tipAccount, lookupTables = [],
  priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS,
}) {
  const tip = maybeTip(funder.publicKey, tipAccount, tipLamports);
  const single = [
    ...computeBudgetInstructions({ units: CU_DISTRIBUTE + sweepCount * CU_SWEEP, priorityMicroLamports }),
    ...tip,
    ...distributeInstructions,
  ];
  const tx = (label, instructions, simulate) => ({
    label, payer: funder.publicKey, instructions, signers: [funder], lookupTables, simulate,
  });
  const split = sweepCount > 0 && !fitsInTransaction({ payer: funder.publicKey, instructions: single, lookupTables });
  const txs = split
    ? [
      tx('sweep creator fees', [
        ...computeBudgetInstructions({ units: sweepCount * CU_SWEEP, priorityMicroLamports }),
        ...tip,
        ...distributeInstructions.slice(0, sweepCount),
      ], true),
      // Simulated alone it would meet the un-swept curve bucket (6095), so only the bundle runs it.
      tx('distribute fees', [
        ...computeBudgetInstructions({ units: CU_DISTRIBUTE, priorityMicroLamports }),
        ...distributeInstructions.slice(sweepCount),
      ], false),
    ]
    : [tx('distribute fees', single, true)];
  return {
    summary: {
      kind: 'distribute',
      funder: funder.publicKey.toBase58(),
      mint: new PublicKey(mint).toBase58(),
      vaultLamports,
      waitingLamports,
      sweepCount,
      tipLamports,
    },
    txs,
  };
}

/** Combine plans into one bundle (max 5 txs). Only the first plan should carry a tip. */
export function mergePlans(...plans) {
  const txs = plans.flatMap((p) => p.txs);
  if (txs.length > 5) throw new Error(`A bundle holds at most 5 transactions; this needs ${txs.length}`);
  return { summary: { kind: 'bundle', parts: plans.map((p) => p.summary) }, txs };
}

/**
 * Sign every transaction in the plan against one fresh blockhash, simulate the
 * ones that can be simulated standalone, submit the bundle, and wait for confirmation.
 * @returns {Promise<{bundleId:string, endpoint:string, signatures:string[]}>}
 */
export async function executePlan(connection, plan, { simulate = true, onStage, jitoEndpoints } = {}) {
  onStage?.('blockhash');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const signed = plan.txs.map((t) => buildSignedTx({
    payer: t.payer,
    instructions: t.instructions,
    blockhash,
    signers: t.signers,
    lookupTables: t.lookupTables,
  }));

  if (simulate) {
    onStage?.('simulate');
    for (let i = 0; i < signed.length; i++) {
      if (plan.txs[i].simulate) await simulateOrThrow(connection, signed[i], { label: plan.txs[i].label });
    }
  }

  onStage?.('submit');
  const { bundleId, endpoint } = await sendBundle(signed, { endpoints: jitoEndpoints });
  const signatures = signed.map(signatureOf);
  onStage?.('confirm', { bundleId, signatures });
  await confirmSignatures(connection, signatures, { onPoll: (r) => onStage?.('poll', r) });
  return { bundleId, endpoint, signatures };
}

/** Resolve a tip account once per operation. */
export async function resolveTipAccount() {
  return pickTipAccount(await fetchTipAccounts());
}
