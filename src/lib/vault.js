/**
 * Passphrase encryption for secret keys. Works in browsers and Node 20+
 * (both expose WebCrypto on globalThis.crypto). AES-256-GCM with a key
 * derived by PBKDF2-SHA256; every blob carries its own salt and IV.
 */
const PBKDF2_ITERATIONS = 310_000;
const VERSION = 1;

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
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, usage) {
  const material = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** @returns {Promise<{v:number, kdf:string, iter:number, salt:string, iv:string, ct:string}>} */
export async function encryptSecret(secretKey, passphrase) {
  if (!passphrase || passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, 'encrypt');
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, secretKey);
  return {
    v: VERSION,
    kdf: 'pbkdf2-sha256',
    iter: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
}

/** @returns {Promise<Uint8Array>} */
export async function decryptSecret(blob, passphrase) {
  if (!blob || blob.v !== VERSION) throw new Error('Unsupported vault format');
  const key = await deriveKey(passphrase, fromBase64(blob.salt), 'decrypt');
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(blob.iv) }, key, fromBase64(blob.ct));
    return new Uint8Array(pt);
  } catch {
    throw new Error('Wrong passphrase');
  }
}
