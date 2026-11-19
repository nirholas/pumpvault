import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { buildSignedTx, confirmSignatures, lamportsToSol, signatureOf, solToLamports } from '../src/lib/tx.js';
import { buildCreateInstructions, estimateLaunchCost, validateCoinDetails } from '../src/lib/pump.js';
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

  it('never trims zeros that belong to the integer part', () => {
    expect(lamportsToSol(10_000_000_000, 0)).toBe('10');
    expect(lamportsToSol(100_000_000_000)).toBe('100');
    expect(lamportsToSol(120_000_000_000, 2)).toBe('120');
  });

  it('parses typed decimals digit by digit, so no amount picks up float error', () => {
    expect(solToLamports('0.3')).toBe(300_000_000);
    expect(solToLamports('1.000000001')).toBe(1_000_000_001);
    expect(solToLamports('.5')).toBe(500_000_000);
    expect(solToLamports(' 2 ')).toBe(2_000_000_000);
    expect(solToLamports(1e-7)).toBe(100);
  });

  it('rounds past the ninth decimal half up instead of truncating or drifting', () => {
    expect(solToLamports('0.0000000005')).toBe(1);
    expect(solToLamports('0.0000000004')).toBe(0);
    expect(solToLamports('12.3456789012')).toBe(12_345_678_901);
  });

  it('rejects exponents, blanks, infinities and amounts beyond a safe integer of lamports', () => {
    for (const bad of ['', '.', '1e3', '1 2', '0x10', NaN, Infinity, -0.5, '10000000000']) {
      expect(() => solToLamports(bad)).toThrow(/Invalid SOL/);
    }
  });
});

describe('confirmSignatures', () => {
  /** A connection whose statuses and block height follow the scripted sequences, one entry per poll. */
  const fakeConnection = ({ statuses, heights = [] }) => {
    let poll = 0;
    let heightCalls = 0;
    return {
      polls: () => poll,
      getSignatureStatuses: async (sigs) => ({ value: sigs.map(() => statuses[Math.min(poll, statuses.length - 1)]) }),
      getBlockHeight: async () => {
        poll += 1;
        return heights[Math.min(heightCalls++, heights.length - 1)] ?? 0;
      },
    };
  };
  const confirmed = { confirmationStatus: 'confirmed', err: null };

  it('returns once every signature is confirmed', async () => {
    const connection = fakeConnection({ statuses: [null, null, confirmed], heights: [10, 11] });
    const result = await confirmSignatures(connection, ['a', 'b'], { lastValidBlockHeight: 100, intervalMs: 0 });
    expect(result.map((r) => r.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('fails fast on a transaction that errored on chain', async () => {
    const connection = fakeConnection({ statuses: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }] });
    await expect(confirmSignatures(connection, ['a'], { intervalMs: 0 })).rejects.toThrow(/failed on chain/);
  });

  it('stops as soon as the blockhash expires and says nothing moved', async () => {
    const connection = fakeConnection({ statuses: [null], heights: [99, 100, 101] });
    await expect(confirmSignatures(connection, ['a'], { lastValidBlockHeight: 100, intervalMs: 0 }))
      .rejects.toThrow(/expired before the bundle landed, so nothing was moved/);
    expect(connection.polls()).toBe(3);
  });

  it('still reports success when the bundle surfaces right as the blockhash expires', async () => {
    const connection = fakeConnection({ statuses: [null, confirmed], heights: [101] });
    const result = await confirmSignatures(connection, ['a'], { lastValidBlockHeight: 100, intervalMs: 0 });
    expect(result[0].status).toBe('confirmed');
  });

  it('on a plain timeout, warns that the bundle may still land instead of inviting a blind retry', async () => {
    const connection = fakeConnection({ statuses: [null], heights: [1] });
    await expect(confirmSignatures(connection, ['a'], { lastValidBlockHeight: 100, timeoutMs: 5, intervalMs: 1 }))
      .rejects.toThrow(/can still land until block height 100/);
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

describe('Pump V2 holder rewards', () => {
  it('builds an offline holder-reward create instruction without a network call', async () => {
    const { instructions } = await buildCreateInstructions({
      mint: Keypair.generate().publicKey,
      name: 'Holder Coin', symbol: 'HOLD', uri: 'https://example.com/metadata.json',
      creator: payer.publicKey, user: payer.publicKey, holderReward: true,
    });
    expect(instructions).toHaveLength(1);
    expect(instructions[0].data.at(-1)).toBe(1);
  });

  it('rejects incompatible launch modes before composing an instruction', async () => {
    await expect(buildCreateInstructions({
      mint: Keypair.generate().publicKey,
      name: 'Holder Coin', symbol: 'HOLD', uri: 'https://example.com/metadata.json',
      creator: payer.publicKey, user: payer.publicKey, holderReward: true, mayhemMode: true,
    })).rejects.toThrow(/cannot be combined/i);
  });

  it('refuses cashback launches, which the upgraded program rejects with 6082', async () => {
    await expect(buildCreateInstructions({
      mint: Keypair.generate().publicKey,
      name: 'Cash Coin', symbol: 'CASH', uri: 'https://example.com/metadata.json',
      creator: payer.publicKey, user: payer.publicKey, cashback: true,
    })).rejects.toThrow(/cashback/i);
  });
});
