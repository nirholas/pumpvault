import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { DEFAULT_PRIORITY_MICROLAMPORTS, MAX_TX_BYTES } from './constants.js';

export function computeBudgetInstructions({ units, priorityMicroLamports = DEFAULT_PRIORITY_MICROLAMPORTS }) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
  ];
}

/** Any valid blockhash: a message's size does not depend on which one it carries. */
const SIZING_BLOCKHASH = '11111111111111111111111111111111';

function wireSize(message) {
  return 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
}

/**
 * Bytes a v0 transaction with these instructions takes on the wire, signatures included,
 * or `Infinity` when it cannot be encoded at all. Compare with `MAX_TX_BYTES`.
 */
export function transactionSize({ payer, instructions, lookupTables = [] }) {
  try {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: SIZING_BLOCKHASH,
      instructions,
    }).compileToV0Message(lookupTables);
    return wireSize(message);
  } catch {
    return Infinity;
  }
}

/** True when the transaction fits in one packet (`MAX_TX_BYTES`). */
export function fitsInTransaction(args) {
  return transactionSize(args) <= MAX_TX_BYTES;
}

/** Compile + sign a v0 transaction. `signers` must include the payer. */
export function buildSignedTx({ payer, instructions, blockhash, signers, lookupTables = [] }) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  // web3.js serializes into a fixed 1232 byte buffer, so an oversized message
  // fails there with "encoding overruns Uint8Array", which tells a user nothing.
  // Both the overrun and a message that merely leaves no room for its signatures
  // mean the same thing: this transaction does not fit on the wire.
  const tooBig = () => new Error(
    `Transaction is over the ${MAX_TX_BYTES} byte limit. Split it into fewer instructions.`,
  );
  let size;
  try {
    size = wireSize(message);
  } catch {
    throw tooBig();
  }
  if (size > MAX_TX_BYTES) throw tooBig();

  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  return tx;
}

export function signatureOf(tx) {
  return bs58.encode(tx.signatures[0]);
}

/** Simulate and throw a readable error (with program logs) on failure. */
export async function simulateOrThrow(connection, tx, { label = 'Transaction' } = {}) {
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).slice(-12).join('\n');
    throw new Error(`${label} would fail: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }
  return sim.value;
}

/**
 * Poll signature statuses until all are confirmed.
 *
 * With `lastValidBlockHeight` (from the `getLatestBlockhash` the transactions were signed
 * against), polling ends as soon as the chain passes that height: from then on the
 * transactions can never land, so the caller can safely rebuild and retry. Without it, or
 * if `timeoutMs` runs out first, the outcome is unknown and the error says so, because
 * retrying a launch that later lands would launch twice.
 * @returns {Promise<Array<{signature:string, status:string, err:any}>>}
 */
export async function confirmSignatures(connection, signatures, {
  lastValidBlockHeight, timeoutMs = 90_000, intervalMs = 1500, onPoll,
} = {}) {
  const started = Date.now();
  const check = async () => {
    const { value } = await connection.getSignatureStatuses(signatures);
    const results = value.map((s, i) => ({
      signature: signatures[i],
      status: s?.confirmationStatus || 'pending',
      err: s?.err ?? null,
    }));
    onPoll?.(results);
    const failed = results.find((r) => r.err);
    if (failed) throw new Error(`Transaction ${failed.signature} failed on chain: ${JSON.stringify(failed.err)}`);
    return results.every((r) => r.status === 'confirmed' || r.status === 'finalized') ? results : null;
  };

  while (Date.now() - started < timeoutMs) {
    const done = await check();
    if (done) return done;
    if (lastValidBlockHeight != null && await connection.getBlockHeight('confirmed') > lastValidBlockHeight) {
      // One last look: a transaction in the final valid block can surface a moment after the height moves on.
      const late = await check();
      if (late) return late;
      throw new Error('The blockhash expired before the bundle landed, so nothing was moved. Retry, with a higher tip if this repeats.');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    lastValidBlockHeight != null
      ? `Not confirmed within the wait window, but the bundle can still land until block height ${lastValidBlockHeight}. Check the signatures on an explorer before retrying.`
      : 'Not confirmed within the wait window. Check the signatures on an explorer before retrying: the bundle may still land.',
  );
}

export const solscanTxUrl = (sig) => `https://solscan.io/tx/${sig}`;
export const solscanAccountUrl = (addr) => `https://solscan.io/account/${addr}`;
export const pumpCoinUrl = (mint) => `https://pump.fun/coin/${mint}`;

export function lamportsToSol(lamports, digits = 4) {
  const fixed = (Number(lamports) / 1e9).toFixed(digits);
  // Only zeros after the decimal point are trailing; "10" with digits = 0 stays "10".
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/**
 * Parse a SOL amount (a decimal string, as typed, or a number) into integer lamports.
 * Strings are converted digit by digit, so "0.3" is exactly 300,000,000 with no float
 * rounding; digits past the ninth decimal round half up.
 */
export function solToLamports(sol) {
  const text = typeof sol === 'number'
    ? (Number.isFinite(sol) && Math.abs(sol) < 1e15 ? sol.toFixed(9) : '')
    : String(sol ?? '').trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || !/\d/.test(text)) throw new Error(`Invalid SOL amount: ${sol}`);
  const [, whole, fraction = ''] = match;
  let lamports = BigInt(whole || '0') * 1_000_000_000n + BigInt(fraction.slice(0, 9).padEnd(9, '0'));
  if (fraction.length > 9 && fraction[9] >= '5') lamports += 1n;
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid SOL amount: ${sol}`);
  return Number(lamports);
}
