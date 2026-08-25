import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import {
  CREATE_RENT_LAMPORTS,
  PUMP_ALT_DEVNET,
  PUMP_ALT_MAINNET,
  PUMP_API_BASE,
  PUMP_IPFS_ENDPOINT,
} from './constants.js';

const NAME_MAX = 32;
const SYMBOL_MAX = 10;

export function validateCoinDetails({ name, symbol, description = '' }) {
  const errors = {};
  const n = String(name ?? '').trim();
  const s = String(symbol ?? '').trim();
  if (!n) errors.name = 'Name is required';
  else if (n.length > NAME_MAX) errors.name = `Name must be ${NAME_MAX} characters or fewer`;
  if (!s) errors.symbol = 'Ticker is required';
  else if (s.length > SYMBOL_MAX) errors.symbol = `Ticker must be ${SYMBOL_MAX} characters or fewer`;
  else if (/\s/.test(s)) errors.symbol = 'Ticker cannot contain spaces';
  if (String(description).length > 1000) errors.description = 'Description must be 1000 characters or fewer';
  return errors;
}

/**
 * Upload image + metadata to pump.fun's IPFS pinning endpoint.
 * `image` is a Blob/File (browser) or `{ bytes, filename, type }` (Node).
 * In the browser, point `endpoint` at the proxy (`/api/ipfs`): pump.fun does not send CORS headers.
 * @returns {Promise<{metadataUri:string, imageUri?:string}>}
 */
export async function uploadMetadata(
  { image, name, symbol, description = '', twitter = '', telegram = '', website = '', showName = true },
  { endpoint = PUMP_IPFS_ENDPOINT, fetchImpl = fetch } = {},
) {
  const errors = validateCoinDetails({ name, symbol, description });
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  if (!image) throw new Error('A coin image is required');

  const form = new FormData();
  if (typeof Blob !== 'undefined' && image instanceof Blob) {
    form.append('file', image, image.name || 'image.png');
  } else {
    form.append('file', new Blob([image.bytes], { type: image.type || 'image/png' }), image.filename || 'image.png');
  }
  form.append('name', name.trim());
  form.append('symbol', symbol.trim());
  form.append('description', description);
  form.append('twitter', twitter);
  form.append('telegram', telegram);
  form.append('website', website);
  form.append('showName', String(showName));

  const res = await fetchImpl(endpoint, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`Metadata upload failed (${res.status}): ${text.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Metadata upload returned non-JSON: ${text.slice(0, 200)}`);
  }
  const metadataUri = json.metadataUri || json.metadata_uri;
  if (!metadataUri) throw new Error(`Metadata upload returned no URI: ${text.slice(0, 200)}`);
  return { metadataUri, imageUri: json.metadata?.image };
}

export async function fetchCoin(mint, { apiBase = PUMP_API_BASE, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${apiBase}/coins/${mint}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pump.fun API ${res.status} for coin ${mint}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function fetchCoinsByCreator(creator, { apiBase = PUMP_API_BASE, fetchImpl = fetch, limit = 50, offset = 0 } = {}) {
  const url = `${apiBase}/coins?creator=${creator}&limit=${limit}&offset=${offset}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`pump.fun API ${res.status} listing coins for ${creator}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.coins || [];
  return list.filter((c) => c.creator === String(creator));
}

/**
 * Build the on-chain create (and optional first buy) instructions.
 * `creator` becomes the on-chain creator (earns fees); `user` pays and receives the dev buy.
 */
export async function buildCreateInstructions({
  connection, mint, name, symbol, uri, creator, user, devBuyLamports = 0, mayhemMode = false, cashback = false,
}) {
  const sdk = new OnlinePumpSdk(connection);
  if (devBuyLamports > 0) {
    const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
    const solAmount = new BN(devBuyLamports);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount });
    const instructions = await PUMP_SDK.createV2AndBuyInstructions({
      global, mint, name, symbol, uri, creator, user, amount, solAmount, mayhemMode, cashback,
    });
    return { instructions, tokenAmount: BigInt(amount.toString()) };
  }
  const ix = await PUMP_SDK.createV2Instruction({ mint, name, symbol, uri, creator, user, mayhemMode, cashback });
  return { instructions: [ix], tokenAmount: 0n };
}

/** pump.fun's published ALT keeps create+buy under the 1232-byte limit. */
export async function fetchPumpLookupTables(connection, { cluster = 'mainnet' } = {}) {
  const address = cluster === 'devnet' ? PUMP_ALT_DEVNET : PUMP_ALT_MAINNET;
  const alt = await connection.getAddressLookupTable(address);
  return alt.value ? [alt.value] : [];
}

/** SOL the launch needs, itemised. `feeBudget` covers base fees + priority for both bundle txs. */
export function estimateLaunchCost({ devBuyLamports = 0, tipLamports = 0, rentLamports = CREATE_RENT_LAMPORTS, feeBudgetLamports = 200_000 }) {
  const total = rentLamports + devBuyLamports + tipLamports + feeBudgetLamports;
  return { rentLamports, devBuyLamports, tipLamports, feeBudgetLamports, totalLamports: total };
}

/** Mint keypair whose address ends in `pump`, like pump.fun's own launcher. Runs until found or `maxAttempts`. */
export function grindPumpMint({ suffix = 'pump', maxAttempts = 5_000_000, onProgress } = {}) {
  for (let i = 1; i <= maxAttempts; i++) {
    const kp = Keypair.generate();
    if (kp.publicKey.toBase58().endsWith(suffix)) return kp;
    if (onProgress && i % 50_000 === 0) onProgress(i);
  }
  return Keypair.generate();
}

export { PublicKey };
