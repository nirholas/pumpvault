import { Connection } from '@solana/web3.js';
import { getSettings } from './store.js';

let cached = null;
let cachedUrl = null;

/**
 * The browser's RPC endpoint: the server proxy, unless the stored settings hold a direct
 * https URL (anything else, including a malformed value, falls back to the proxy).
 */
export function rpcUrl() {
  const custom = String(getSettings().rpcUrl ?? '').trim();
  if (custom) {
    try {
      if (new URL(custom).protocol === 'https:') return custom;
    } catch {
      /* not a URL: use the proxy */
    }
  }
  return `${location.origin}/api/rpc`;
}

export function getConnection() {
  const url = rpcUrl();
  if (!cached || cachedUrl !== url) {
    cached = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: false });
    cachedUrl = url;
  }
  return cached;
}

export async function getBalanceLamports(pubkey) {
  return getConnection().getBalance(pubkey, 'confirmed');
}

/** pump.fun API calls always go through the proxy (the upstream blocks browser origins). */
export const PUMP_API_PROXY = `${location.origin}/api/pump`;
export const IPFS_PROXY = `${location.origin}/api/ipfs`;
