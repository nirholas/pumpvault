import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Parse a secret key in any of the formats wallets export:
 *   - base58 64-byte secret (Phantom, Solflare, Backpack "export private key")
 *   - JSON byte array `[12, 34, ...]` (solana-keygen / CLI id.json)
 *   - hex (64 or 128 chars)
 *
 * A bare 32-byte value is refused unless `allowSeed` is set. It is ambiguous:
 * a Solana public key is also 32 bytes, so accepting it silently would derive a
 * wallet the user does not own and hand them an address that is not theirs.
 */
export function parseSecretKey(input, { allowSeed = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Secret key is empty');

  let bytes;
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('JSON secret must be an array of bytes');
    }
    bytes = Uint8Array.from(arr);
  } else if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw) || /^(0x)?[0-9a-fA-F]{128}$/.test(raw)) {
    const hex = raw.replace(/^0x/, '');
    bytes = Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  } else {
    try {
      bytes = bs58.decode(raw);
    } catch {
      throw new Error('Secret key is not base58, hex, or a JSON byte array');
    }
  }

  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) {
    if (allowSeed) return Keypair.fromSeed(bytes);
    throw new Error(
      'That is 32 bytes, which is the length of a public key as well as a seed. ' +
      'Paste the full private key your wallet exports (64 bytes), not the address.',
    );
  }
  throw new Error(`Secret key must be 64 bytes, got ${bytes.length}`);
}

export function secretKeyToBase58(keypair) {
  return bs58.encode(keypair.secretKey);
}

export function secretKeyToJson(keypair) {
  return JSON.stringify(Array.from(keypair.secretKey));
}

export function isPublicKey(value) {
  try {
    new PublicKey(String(value).trim());
    return true;
  } catch {
    return false;
  }
}

export function toPublicKey(value, label = 'address') {
  try {
    return new PublicKey(String(value).trim());
  } catch {
    throw new Error(`${label} is not a valid Solana address`);
  }
}

export function shortAddress(value, chars = 4) {
  const s = typeof value === 'string' ? value : value.toBase58();
  return `${s.slice(0, chars)}…${s.slice(-chars)}`;
}
