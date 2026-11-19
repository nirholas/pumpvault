import { PublicKey, SystemProgram } from '@solana/web3.js';
import { JITO_BLOCK_ENGINES, JITO_TIP_ACCOUNTS_FALLBACK } from './constants.js';

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** How long one block-engine request may take before the next region is tried. */
export const JITO_REQUEST_TIMEOUT_MS = 10_000;

async function rpc(endpoint, path, method, params, { timeoutMs = JITO_REQUEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(`Jito ${method}: ${e?.name === 'TimeoutError' ? `no response in ${timeoutMs} ms` : 'network error'}`);
    err.retryable = true;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error?.message || body.error?.data || `${res.status} ${res.statusText}`;
    const err = new Error(`Jito ${method}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return body.result;
}

function isAddress(value) {
  if (typeof value !== 'string') return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

/**
 * Live tip accounts from the block engine, falling back to the pinned snapshot.
 * Entries that are not valid addresses are dropped; a response with none left counts as a failure.
 */
export async function fetchTipAccounts(endpoints = JITO_BLOCK_ENGINES, { timeoutMs, fetchImpl } = {}) {
  for (const endpoint of endpoints) {
    try {
      const list = await rpc(endpoint, '/api/v1/bundles', 'getTipAccounts', [], { timeoutMs, fetchImpl });
      const valid = Array.isArray(list) ? list.filter(isAddress) : [];
      if (valid.length) return valid;
    } catch {
      /* try the next region */
    }
  }
  return JITO_TIP_ACCOUNTS_FALLBACK;
}

export function pickTipAccount(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('No Jito tip accounts to choose from');
  return new PublicKey(list[Math.floor(Math.random() * list.length)]);
}

export function tipInstruction(payer, tipAccount, lamports) {
  if (!Number.isInteger(lamports) || lamports < 1000) throw new Error('Jito tip must be at least 1000 lamports');
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipAccount, lamports });
}

/**
 * Submit a bundle (1 to 5 signed VersionedTransactions). Tries every block
 * engine in order and returns on the first acceptance.
 * @returns {Promise<{bundleId:string, endpoint:string}>}
 */
export async function sendBundle(transactions, { endpoints = JITO_BLOCK_ENGINES, timeoutMs, fetchImpl } = {}) {
  if (!transactions.length || transactions.length > 5) throw new Error('A bundle holds 1 to 5 transactions');
  // Base64 is what the block engine documents; base58 bundles are deprecated.
  const encoded = transactions.map((tx) => toBase64(tx.serialize()));
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      // Resubmitting after a timeout is safe: the same signed transactions can land at most once.
      const bundleId = await rpc(endpoint, '/api/v1/bundles', 'sendBundle', [encoded, { encoding: 'base64' }], { timeoutMs, fetchImpl });
      if (typeof bundleId !== 'string' || !bundleId) throw new Error('Jito sendBundle: no bundle id in the response');
      return { bundleId, endpoint };
    } catch (e) {
      errors.push(`${new URL(endpoint).host}: ${e.message}`);
      if (!e.retryable && e.status !== undefined && e.status < 500 && e.status !== 429) {
        // A 4xx that is not rate limiting means the bundle itself is rejected; no region will accept it.
        break;
      }
    }
  }
  throw new Error(`Bundle rejected by every block engine.\n${errors.join('\n')}`);
}

/** Single transaction through Jito's sendTransaction (still MEV-protected, no bundle atomicity). */
export async function sendTransactionJito(transaction, { endpoints = JITO_BLOCK_ENGINES, timeoutMs, fetchImpl } = {}) {
  const b64 = toBase64(transaction.serialize());
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const signature = await rpc(endpoint, '/api/v1/transactions', 'sendTransaction', [b64, { encoding: 'base64' }], { timeoutMs, fetchImpl });
      return { signature, endpoint };
    } catch (e) {
      errors.push(`${new URL(endpoint).host}: ${e.message}`);
    }
  }
  throw new Error(`Transaction rejected by every block engine.\n${errors.join('\n')}`);
}

export async function getBundleStatuses(bundleIds, { endpoint = JITO_BLOCK_ENGINES[0], timeoutMs, fetchImpl } = {}) {
  return rpc(endpoint, '/api/v1/bundles', 'getBundleStatuses', [bundleIds], { timeoutMs, fetchImpl });
}

export function jitoExplorerUrl(bundleId) {
  return `https://explorer.jito.wtf/bundle/${bundleId}`;
}
