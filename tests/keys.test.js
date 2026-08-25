import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { isPublicKey, parseSecretKey, secretKeyToBase58, secretKeyToJson, shortAddress, toPublicKey } from '../src/lib/keys.js';

const kp = Keypair.generate();

describe('parseSecretKey', () => {
  it('reads a base58 64-byte secret, the Phantom export format', () => {
    expect(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('reads a JSON byte array, the solana-keygen format', () => {
    expect(parseSecretKey(secretKeyToJson(kp)).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('reads a 32-byte seed only when the caller opts in', () => {
    const seed = kp.secretKey.slice(0, 32);
    expect(parseSecretKey(bs58.encode(seed), { allowSeed: true }).publicKey.toBase58())
      .toBe(Keypair.fromSeed(seed).publicKey.toBase58());
  });

  it('reads hex, with or without the 0x prefix', () => {
    const hex = Buffer.from(kp.secretKey).toString('hex');
    expect(parseSecretKey(hex).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(parseSecretKey(`0x${hex}`).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('tolerates surrounding whitespace from a sloppy paste', () => {
    expect(parseSecretKey(`  ${secretKeyToBase58(kp)}\n`).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('rejects an empty value', () => {
    expect(() => parseSecretKey('   ')).toThrow(/empty/i);
  });

  it('rejects a public key pasted where a secret belongs, instead of silently deriving a foreign wallet', () => {
    expect(() => parseSecretKey(kp.publicKey.toBase58())).toThrow(/public key/i);
  });

  it('rejects a 32-byte value by default even when it really is a seed, because it cannot tell them apart', () => {
    expect(() => parseSecretKey(bs58.encode(kp.secretKey.slice(0, 32)))).toThrow(/public key/i);
  });

  it('rejects arbitrary text', () => {
    expect(() => parseSecretKey('definitely not a key')).toThrow(/not base58/i);
  });

  it('rejects a JSON array holding values outside a byte', () => {
    expect(() => parseSecretKey('[1,2,300]')).toThrow(/array of bytes/i);
  });
});

describe('address helpers', () => {
  it('accepts a real address and rejects a malformed one', () => {
    expect(isPublicKey(kp.publicKey.toBase58())).toBe(true);
    expect(isPublicKey('nope')).toBe(false);
    expect(isPublicKey('')).toBe(false);
  });

  it('names the field in the error so a form can show it', () => {
    expect(() => toPublicKey('nope', 'Destination')).toThrow(/^Destination is not a valid/);
  });

  it('shortens an address while keeping both ends recognisable', () => {
    const short = shortAddress(kp.publicKey.toBase58());
    expect(short.startsWith(kp.publicKey.toBase58().slice(0, 4))).toBe(true);
    expect(short.endsWith(kp.publicKey.toBase58().slice(-4))).toBe(true);
  });
});
