import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** In-memory Web Storage, enough for the store module. */
class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
  dump() { return [...this.#data.values()].join('\n'); }
}

const PASS = 'correct horse battery staple';
let store;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  store = await import('../src/ui/store.js');
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('wallet store', () => {
  it('keeps only ciphertext at rest: no secret key bytes in localStorage', async () => {
    await store.unlock(PASS);
    const imported = Keypair.generate();
    const pubkey = await store.importWallet(bs58.encode(imported.secretKey), { label: 'imported' });
    const generated = await store.createWallet({ label: 'generated' });
    const atRest = localStorage.dump();
    expect(atRest).not.toContain(bs58.encode(imported.secretKey));
    expect(atRest).not.toContain(Buffer.from(imported.secretKey).toString('base64'));
    expect(atRest).not.toContain(JSON.stringify(Array.from(imported.secretKey)));
    expect(store.getKeypair(pubkey).secretKey).toEqual(imported.secretKey);
    expect(store.getKeypair(generated).publicKey.toBase58()).toBe(generated);
  });

  it('zeroes the secret bytes of every held keypair on lock, not just the references', async () => {
    const [first] = store.listWallets();
    const keypair = store.getKeypair(first.pubkey);
    store.lock();
    expect(keypair.secretKey.every((b) => b === 0)).toBe(true);
    expect(() => store.getKeypair(first.pubkey)).toThrow(/locked/);
    expect(sessionStorage.getItem('pumpvault.session.v1')).toBeNull();
  });

  it('restores every wallet on unlock with the right passphrase and refuses a wrong one', async () => {
    await expect(store.unlock('not the passphrase')).rejects.toThrow(/Wrong passphrase/);
    expect(store.isUnlocked()).toBe(false);
    await store.unlock(PASS);
    for (const w of store.listWallets()) expect(store.getKeypair(w.pubkey).publicKey.toBase58()).toBe(w.pubkey);
  });

  it('zeroes a removed wallet\'s key immediately', async () => {
    const [first] = store.listWallets();
    const keypair = store.getKeypair(first.pubkey);
    store.removeWallet(first.pubkey);
    expect(keypair.secretKey.every((b) => b === 0)).toBe(true);
    expect(store.getWallet(first.pubkey)).toBeNull();
  });

  it('re-encrypts a blob from the older 310,000-iteration default after unlocking', async () => {
    const [w] = store.listWallets();
    const secret = store.getKeypair(w.pubkey).secretKey;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret));
    const b64 = (b) => Buffer.from(b).toString('base64');
    store.updateWallet(w.pubkey, { vault: { v: 1, kdf: 'pbkdf2-sha256', iter: 310_000, salt: b64(salt), iv: b64(iv), ct: b64(ct) } });

    store.lock();
    await store.unlock(PASS);
    await vi.waitFor(() => expect(store.getWallet(w.pubkey).vault.iter).toBe(600_000), { timeout: 10_000 });
    store.lock();
    await store.unlock(PASS);
    expect(store.getKeypair(w.pubkey).secretKey).toEqual(secret);
  });
});
