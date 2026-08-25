import { Connection } from '@solana/web3.js';
import { getSettings } from './store.js';

let cached = null;
let cachedUrl = null;

/** The browser's RPC endpoint: the server proxy unless the user set a direct URL in settings. */
export function rpcUrl() {
  const custom = getSettings().rpcUrl?.trim();
  return custom || `${location.origin}/api/rpc`;
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
