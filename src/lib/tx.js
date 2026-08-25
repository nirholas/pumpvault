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
    size = 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
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
 * Poll signature statuses until all are confirmed (or the blockhash expires).
 * @returns {Promise<Array<{signature:string, status:string, err:any}>>}
 */
export async function confirmSignatures(connection, signatures, { timeoutMs = 90_000, intervalMs = 1500, onPoll } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value } = await connection.getSignatureStatuses(signatures);
    const results = value.map((s, i) => ({
      signature: signatures[i],
      status: s?.confirmationStatus || 'pending',
      err: s?.err ?? null,
    }));
    onPoll?.(results);
    const failed = results.find((r) => r.err);
    if (failed) throw new Error(`Transaction ${failed.signature} failed on chain: ${JSON.stringify(failed.err)}`);
    if (results.every((r) => r.status === 'confirmed' || r.status === 'finalized')) return results;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Not confirmed within the wait window. Bundles that miss their slot are dropped with no funds moved; retry with a higher tip.');
}

export const solscanTxUrl = (sig) => `https://solscan.io/tx/${sig}`;
export const solscanAccountUrl = (addr) => `https://solscan.io/account/${addr}`;
export const pumpCoinUrl = (mint) => `https://pump.fun/coin/${mint}`;

export function lamportsToSol(lamports, digits = 4) {
  return (Number(lamports) / 1e9).toFixed(digits).replace(/\.?0+$/, '') || '0';
}

export function solToLamports(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid SOL amount: ${sol}`);
  return Math.round(n * 1e9);
}
