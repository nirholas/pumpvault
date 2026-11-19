import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PBKDF2_ITERATIONS, decryptSecret, encryptSecret, needsRehash } from '../src/lib/vault.js';

const secret = Keypair.generate().secretKey;

describe('vault encryption', () => {
  it('round-trips a secret key through a passphrase', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    expect(new Uint8Array(await decryptSecret(blob, 'a-long-enough-passphrase'))).toEqual(secret);
  });

  it('never stores the plaintext key in the blob', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    expect(JSON.stringify(blob)).not.toContain(Buffer.from(secret).toString('base64'));
    expect(blob.ct).not.toBe(Buffer.from(secret).toString('base64'));
  });

  it('uses a fresh salt and IV per encryption, so identical keys differ at rest', async () => {
    const a = await encryptSecret(secret, 'a-long-enough-passphrase');
    const b = await encryptSecret(secret, 'a-long-enough-passphrase');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('reports a wrong passphrase without leaking anything else', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    await expect(decryptSecret(blob, 'wrong-passphrase')).rejects.toThrow('Wrong passphrase');
  });

  it('refuses a passphrase too short to be worth encrypting with', async () => {
    await expect(encryptSecret(secret, 'short')).rejects.toThrow(/at least 8/i);
  });

  it('refuses a blob from an unknown format version', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    await expect(decryptSecret({ ...blob, v: 99 }, 'a-long-enough-passphrase')).rejects.toThrow(/Unsupported vault format/);
  });

  it('detects tampering with the ciphertext', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    const bytes = Buffer.from(blob.ct, 'base64');
    bytes[0] ^= 0xff;
    await expect(decryptSecret({ ...blob, ct: bytes.toString('base64') }, 'a-long-enough-passphrase')).rejects.toThrow();
  });

  it('derives new keys with at least the OWASP PBKDF2-SHA256 work factor and records it in the blob', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(blob).toMatchObject({ v: 1, kdf: 'pbkdf2-sha256', iter: PBKDF2_ITERATIONS });
    expect(Buffer.from(blob.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(blob.iv, 'base64')).toHaveLength(12);
    // 64-byte secret plus the 16-byte GCM tag.
    expect(Buffer.from(blob.ct, 'base64')).toHaveLength(80);
  });

  it('still opens a blob written with the previous 310,000-iteration default, and flags it for re-encryption', async () => {
    const passphrase = 'a-long-enough-passphrase';
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret));
    const b64 = (b) => Buffer.from(b).toString('base64');
    const legacy = { v: 1, kdf: 'pbkdf2-sha256', iter: 310_000, salt: b64(salt), iv: b64(iv), ct: b64(ct) };

    expect(await decryptSecret(legacy, passphrase)).toEqual(secret);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(await encryptSecret(secret, passphrase))).toBe(false);
  });

  it('refuses a stored iteration count that is too weak to trust or large enough to hang the tab', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    for (const iter of [1, 99_999, 10_000_001, 1.5, '600000', undefined]) {
      await expect(decryptSecret({ ...blob, iter }, 'a-long-enough-passphrase')).rejects.toThrow(/Unsupported vault format/);
    }
  });

  it('refuses an unknown KDF and malformed salt, IV or ciphertext without attempting a decrypt', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    await expect(decryptSecret({ ...blob, kdf: 'scrypt' }, 'x')).rejects.toThrow(/Unsupported vault format/);
    await expect(decryptSecret({ ...blob, iv: Buffer.alloc(8).toString('base64') }, 'x')).rejects.toThrow(/Corrupt/);
    await expect(decryptSecret({ ...blob, salt: '%%%' }, 'x')).rejects.toThrow(/Corrupt/);
    await expect(decryptSecret({ ...blob, ct: Buffer.alloc(16).toString('base64') }, 'x')).rejects.toThrow(/Corrupt/);
    await expect(decryptSecret({ ...blob, ct: 42 }, 'x')).rejects.toThrow(/Corrupt/);
  });

  it('refuses to encrypt something that is not key bytes', async () => {
    await expect(encryptSecret('not bytes', 'a-long-enough-passphrase')).rejects.toThrow(/Nothing to encrypt/);
    await expect(encryptSecret(new Uint8Array(0), 'a-long-enough-passphrase')).rejects.toThrow(/Nothing to encrypt/);
  });

  it('returns bytes the caller can wipe without affecting a later decrypt', async () => {
    const blob = await encryptSecret(secret, 'a-long-enough-passphrase');
    const first = await decryptSecret(blob, 'a-long-enough-passphrase');
    first.fill(0);
    expect(await decryptSecret(blob, 'a-long-enough-passphrase')).toEqual(secret);
  });
});
