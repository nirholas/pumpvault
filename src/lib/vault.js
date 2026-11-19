/**
 * Passphrase encryption for secret keys. Works in browsers and Node 20+
 * (both expose WebCrypto on globalThis.crypto). AES-256-GCM with a key
 * derived by PBKDF2-SHA256; every blob carries its own salt and IV.
 *
 * New blobs use OWASP's current PBKDF2-SHA256 work factor. Each blob records
 * its own iteration count, so blobs written with an older count still decrypt
 * (within sane bounds) and `needsRehash` tells the caller to re-encrypt them.
 */
export const PBKDF2_ITERATIONS = 600_000;
/** Accepted range for a stored count: below it is too weak to trust, above it a decrypt would hang the tab. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const VERSION = 1;
const KDF = 'pbkdf2-sha256';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available in this environment');
  return c.subtle;
};

const enc = new TextEncoder();

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(str) {
  if (typeof str !== 'string') throw new Error('Corrupt vault entry');
  let bin;
  try {
    bin = atob(str);
  } catch {
    throw new Error('Corrupt vault entry');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations, usage) {
  const bytes = enc.encode(passphrase);
  let material;
  try {
    material = await subtle().importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
  } finally {
    bytes.fill(0);
  }
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** @returns {Promise<{v:number, kdf:string, iter:number, salt:string, iv:string, ct:string}>} */
export async function encryptSecret(secretKey, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
  if (!(secretKey instanceof Uint8Array) || secretKey.length === 0) throw new Error('Nothing to encrypt');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS, 'encrypt');
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, secretKey);
  return {
    v: VERSION,
    kdf: KDF,
    iter: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
}

/**
 * Decrypt a blob from `encryptSecret`. The caller owns the returned bytes and
 * should zero them (`fill(0)`) once the key is no longer needed.
 * @returns {Promise<Uint8Array>}
 */
export async function decryptSecret(blob, passphrase) {
  if (!blob || blob.v !== VERSION || blob.kdf !== KDF) throw new Error('Unsupported vault format');
  if (!Number.isInteger(blob.iter) || blob.iter < MIN_ITERATIONS || blob.iter > MAX_ITERATIONS) {
    throw new Error('Unsupported vault format');
  }
  const salt = fromBase64(blob.salt);
  const iv = fromBase64(blob.iv);
  const ct = fromBase64(blob.ct);
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ct.length <= GCM_TAG_BYTES) {
    throw new Error('Corrupt vault entry');
  }
  const key = await deriveKey(String(passphrase ?? ''), salt, blob.iter, 'decrypt');
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(pt);
  } catch {
    throw new Error('Wrong passphrase');
  }
}

/** True when a blob was written with fewer PBKDF2 iterations than new blobs get, so it should be re-encrypted. */
export function needsRehash(blob) {
  return Boolean(blob) && Number.isInteger(blob.iter) && blob.iter < PBKDF2_ITERATIONS;
}
