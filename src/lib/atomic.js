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
  CU_BUY, CU_COLLECT, CU_CREATE, CU_TRANSFER,
  DEFAULT_PRIORITY_MICROLAMPORTS,
  RENT_EXEMPT_MIN_LAMPORTS,
} from './constants.js';
import { fetchTipAccounts, pickTipAccount, sendBundle, tipInstruction } from './jito.js';
import { buildSignedTx, computeBudgetInstructions, confirmSignatures, signatureOf, simulateOrThrow } from './tx.js';

/**
 * A plan is a list of transactions to land atomically in one Jito bundle,
 * plus a human-readable summary the UI shows before anything is signed.
 * Nothing in a plan is signed or sent until `executePlan` runs.
 */

const same = (a, b) => a.publicKey.toBase58() === b.publicKey.toBase58();
const dedupeSigners = (list) => [...new Map(list.map((k) => [k.publicKey.toBase58(), k])).values()];
/** A zero tip means "this tx rides in a bundle whose first tx already tipped". */
const maybeTip = (payer, tipAccount, lamports) => (lamports > 0 ? [tipInstruction(payer, tipAccount, lamports)] : []);

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
 * Collect creator fees and, in the same transaction, move the creator's SOL
 * to `destination`. A leaked creator key never holds a balance a sweeper can take.
 * With `destination` omitted (or equal to the creator) it is a plain claim.
 */
export function planCollect({
  funder, creator, destination = null, collectInstructions,
  vaultLamports, creatorBalanceLamports, tipLamports, tipAccount,
  keepLamports = RENT_EXEMPT_MIN_LAMPORTS, priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS,
}) {
  const instructions = [
    ...computeBudgetInstructions({ units: CU_COLLECT, priorityMicroLamports }),
    ...maybeTip(funder.publicKey, tipAccount, tipLamports),
    ...collectInstructions,
  ];
  const dest = destination ? new PublicKey(destination) : null;
  const drain = dest && !dest.equals(creator.publicKey);
  let drainLamports = 0;
  if (drain) {
    const feeReserve = same(funder, creator) ? tipLamports + 100_000 : 0;
    drainLamports = creatorBalanceLamports + vaultLamports - keepLamports - feeReserve;
    if (drainLamports <= 0) throw new Error('Nothing to move: vault + balance do not cover the rent-exempt buffer');
    instructions.push(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: dest, lamports: drainLamports }));
  }
  return {
    summary: {
      kind: 'collect',
      funder: funder.publicKey.toBase58(),
      creator: creator.publicKey.toBase58(),
      destination: drain ? dest.toBase58() : creator.publicKey.toBase58(),
      vaultLamports,
      drainLamports,
      tipLamports,
      keepLamports: drain ? keepLamports : 0,
    },
    txs: [{
      label: 'collect fees',
      payer: funder.publicKey,
      instructions,
      signers: dedupeSigners([funder, creator]),
      simulate: true,
    }],
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

/** Crank a fee-sharing config: every shareholder gets paid, funder covers fee + tip. */
export function planDistribute({
  funder, mint, distributeInstructions, vaultLamports, tipLamports, tipAccount,
  priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS,
}) {
  return {
    summary: {
      kind: 'distribute',
      funder: funder.publicKey.toBase58(),
      mint: new PublicKey(mint).toBase58(),
      vaultLamports,
      tipLamports,
    },
    txs: [{
      label: 'distribute fees',
      payer: funder.publicKey,
      instructions: [
        ...computeBudgetInstructions({ units: 300_000, priorityMicroLamports }),
        ...maybeTip(funder.publicKey, tipAccount, tipLamports),
        ...distributeInstructions,
      ],
      signers: [funder],
      simulate: true,
    }],
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
