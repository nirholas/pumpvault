import { PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { JITO_BLOCK_ENGINES, JITO_TIP_ACCOUNTS_FALLBACK } from './constants.js';

async function rpc(endpoint, path, method, params, { signal } = {}) {
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
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

/** Live tip accounts from the block engine, falling back to the pinned snapshot. */
export async function fetchTipAccounts(endpoints = JITO_BLOCK_ENGINES) {
  for (const endpoint of endpoints) {
    try {
      const list = await rpc(endpoint, '/api/v1/bundles', 'getTipAccounts', []);
      if (Array.isArray(list) && list.length) return list;
    } catch {
      /* try the next region */
    }
  }
  return JITO_TIP_ACCOUNTS_FALLBACK;
}

export function pickTipAccount(list) {
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
export async function sendBundle(transactions, { endpoints = JITO_BLOCK_ENGINES } = {}) {
  if (!transactions.length || transactions.length > 5) throw new Error('A bundle holds 1 to 5 transactions');
  const encoded = transactions.map((tx) => bs58.encode(tx.serialize()));
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const bundleId = await rpc(endpoint, '/api/v1/bundles', 'sendBundle', [encoded]);
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
export async function sendTransactionJito(transaction, { endpoints = JITO_BLOCK_ENGINES } = {}) {
  const b64 = Buffer.from(transaction.serialize()).toString('base64');
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const signature = await rpc(endpoint, '/api/v1/transactions', 'sendTransaction', [b64, { encoding: 'base64' }]);
      return { signature, endpoint };
    } catch (e) {
      errors.push(`${new URL(endpoint).host}: ${e.message}`);
    }
  }
  throw new Error(`Transaction rejected by every block engine.\n${errors.join('\n')}`);
}

export async function getBundleStatuses(bundleIds, { endpoint = JITO_BLOCK_ENGINES[0] } = {}) {
  return rpc(endpoint, '/api/v1/bundles', 'getBundleStatuses', [bundleIds]);
}

export function jitoExplorerUrl(bundleId) {
  return `https://explorer.jito.wtf/bundle/${bundleId}`;
}
