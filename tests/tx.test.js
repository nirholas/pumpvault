import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { buildSignedTx, lamportsToSol, signatureOf, solToLamports } from '../src/lib/tx.js';
import { estimateLaunchCost, validateCoinDetails } from '../src/lib/pump.js';
import { pickTipAccount, tipInstruction } from '../src/lib/jito.js';
import { JITO_TIP_ACCOUNTS_FALLBACK } from '../src/lib/constants.js';

const payer = Keypair.generate();
const BLOCKHASH = '11111111111111111111111111111111';

describe('SOL formatting', () => {
  it('converts SOL to lamports without float drift', () => {
    expect(solToLamports('0.05')).toBe(50_000_000);
    expect(solToLamports(0.1)).toBe(100_000_000);
    expect(solToLamports('0.0001')).toBe(100_000);
  });

  it('rejects a negative or unparseable amount', () => {
    expect(() => solToLamports('-1')).toThrow(/Invalid SOL/);
    expect(() => solToLamports('abc')).toThrow(/Invalid SOL/);
  });

  it('trims trailing zeros so amounts read cleanly', () => {
    expect(lamportsToSol(50_000_000)).toBe('0.05');
    expect(lamportsToSol(1_000_000_000)).toBe('1');
    expect(lamportsToSol(0)).toBe('0');
  });
});

describe('buildSignedTx', () => {
  it('signs and exposes the signature', () => {
    const tx = buildSignedTx({
      payer: payer.publicKey,
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
      blockhash: BLOCKHASH,
      signers: [payer],
    });
    expect(signatureOf(tx)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
  });

  it('refuses a transaction over the 1232 byte wire limit instead of failing at submit time', () => {
    const many = Array.from({ length: 40 }, () =>
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    expect(() => buildSignedTx({ payer: payer.publicKey, instructions: many, blockhash: BLOCKHASH, signers: [payer] }))
      .toThrow(/over the 1232 byte limit/);
  });
});

describe('jito tips', () => {
  it('always picks a real tip account, which every bundle must write-lock', () => {
    for (let i = 0; i < 25; i++) {
      expect(JITO_TIP_ACCOUNTS_FALLBACK).toContain(pickTipAccount(JITO_TIP_ACCOUNTS_FALLBACK).toBase58());
    }
  });

  it('refuses a tip below the amount Jito accepts', () => {
    expect(() => tipInstruction(payer.publicKey, Keypair.generate().publicKey, 999)).toThrow(/at least 1000 lamports/);
  });
});

describe('coin validation', () => {
  it('accepts ordinary details', () => {
    expect(validateCoinDetails({ name: 'Nyan Cat', symbol: 'NYAN' })).toEqual({});
  });

  it('requires a name and a ticker', () => {
    expect(validateCoinDetails({ name: '', symbol: '' })).toMatchObject({ name: expect.any(String), symbol: expect.any(String) });
  });

  it('enforces the on-chain metadata length limits', () => {
    expect(validateCoinDetails({ name: 'x'.repeat(33), symbol: 'OK' }).name).toMatch(/32/);
    expect(validateCoinDetails({ name: 'OK', symbol: 'x'.repeat(11) }).symbol).toMatch(/10/);
  });

  it('rejects a ticker with a space in it', () => {
    expect(validateCoinDetails({ name: 'OK', symbol: 'NY AN' }).symbol).toMatch(/spaces/);
  });
});

describe('estimateLaunchCost', () => {
  it('adds up every component the payer actually spends', () => {
    const cost = estimateLaunchCost({ devBuyLamports: 20_000_000, tipLamports: 1_000_000, rentLamports: 30_000_000, feeBudgetLamports: 200_000 });
    expect(cost.totalLamports).toBe(51_200_000);
  });

  it('still charges rent, tip and fees when there is no dev buy', () => {
    const cost = estimateLaunchCost({ tipLamports: 1_000_000 });
    expect(cost.devBuyLamports).toBe(0);
    expect(cost.totalLamports).toBeGreaterThan(1_000_000);
  });
});
