import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { decryptSecret, encryptSecret } from '../src/lib/vault.js';

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
});
