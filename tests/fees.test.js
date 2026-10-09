import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { OFFLINE_PUMP_AMM_PROGRAM, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import { PUMP_SDK, bondingCurvePda } from '../src/lib/pump-sdk.node.js';
import {
  BONDING_CURVE_CREATOR_OFFSET, BONDING_CURVE_DISCRIMINATOR, POOL_COIN_CREATOR_OFFSET, POOL_DISCRIMINATOR,
  PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID,
} from '../src/lib/constants.js';
import {
  buildSweepInstructions, getWaitingCreatorFees, resolveCurveMint, scanCreatorCurves, scanCreatorPools,
} from '../src/lib/fees.js';

const { pumpIdl } = createRequire(import.meta.url)('@pump-fun/pump-sdk');
const key = () => Keypair.generate().publicKey;
const idlDiscriminator = (idl, name) => bs58.encode(Uint8Array.from(idl.accounts.find((a) => a.name === name).discriminator));

/*
 * Accounts built byte by byte at the offsets the Pump and PumpSwap IDLs define, so the
 * tests exercise the SDK decoders on the same layouts the programs write: the pre-upgrade
 * (shorter) accounts that have not been touched since, and the current, longer ones.
 */
const CURVE = { creator: 49, quoteMint: 83, creatorFee: 125, size: 166 };
const POOL = { quoteMint: 75, coinCreator: 211, virtualQuoteReserves: 245, creatorFees: 279, size: 287 };

function curveBytes({ creator, quoteMint = null, creatorFee = 0n, size = CURVE.size }) {
  const data = Buffer.alloc(Math.max(size, CURVE.size));
  bs58.decode(BONDING_CURVE_DISCRIMINATOR).forEach((b, i) => { data[i] = b; });
  creator.toBuffer().copy(data, CURVE.creator);
  if (quoteMint) quoteMint.toBuffer().copy(data, CURVE.quoteMint);
  data.writeBigUInt64LE(creatorFee, CURVE.creatorFee);
  return data.subarray(0, size);
}

function poolBytes({ baseMint, coinCreator, quoteMint = NATIVE_MINT, creatorFees = 0n, virtualQuoteReserves = 0n, size = POOL.size }) {
  const data = Buffer.alloc(Math.max(size, POOL.size));
  bs58.decode(POOL_DISCRIMINATOR).forEach((b, i) => { data[i] = b; });
  baseMint.toBuffer().copy(data, 43);
  quoteMint.toBuffer().copy(data, POOL.quoteMint);
  coinCreator.toBuffer().copy(data, POOL.coinCreator);
  data.writeBigInt64LE(BigInt.asIntN(64, virtualQuoteReserves), POOL.virtualQuoteReserves);
  data.writeBigInt64LE(virtualQuoteReserves < 0n ? -1n : 0n, POOL.virtualQuoteReserves + 8);
  data.writeBigUInt64LE(creatorFees, POOL.creatorFees);
  return data.subarray(0, size);
}

const account = (data, owner) => ({ data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0 });

/** In-memory RPC: program accounts are matched against the memcmp filters exactly as a node would. */
function memoryConnection({ programAccounts = [], tokenAccounts = [] }) {
  const calls = [];
  const matches = (data, { memcmp }) => Buffer.from(bs58.decode(memcmp.bytes)).equals(data.subarray(memcmp.offset, memcmp.offset + bs58.decode(memcmp.bytes).length));
  return {
    calls,
    async getProgramAccounts(programId, config) {
      calls.push({ programId: programId.toBase58(), config });
      return programAccounts
        .filter((a) => a.account.owner.equals(programId) && config.filters.every((f) => matches(a.account.data, f)));
    },
    async getParsedTokenAccountsByOwner(owner, { programId }) {
      return {
        value: tokenAccounts
          .filter((t) => t.owner.equals(owner) && t.programId.equals(programId))
          .map((t) => ({ pubkey: key(), account: { data: { parsed: { info: { mint: t.mint.toBase58() } } } } })),
      };
    },
  };
}

describe('account layouts', () => {
  it('uses the BondingCurve and Pool discriminators from the IDLs', () => {
    expect(BONDING_CURVE_DISCRIMINATOR).toBe(idlDiscriminator(pumpIdl, 'BondingCurve'));
    expect(POOL_DISCRIMINATOR).toBe(idlDiscriminator(OFFLINE_PUMP_AMM_PROGRAM.idl, 'pool'));
  });

  it('finds the curve creator and the pool coin creator at the scanned offsets', () => {
    const creator = key();
    expect(PUMP_SDK.decodeBondingCurve(account(curveBytes({ creator }), PUMP_PROGRAM_ID)).creator.equals(creator)).toBe(true);
    const pool = PUMP_AMM_SDK.decodePool(account(poolBytes({ baseMint: key(), coinCreator: creator }), PUMP_AMM_PROGRAM_ID));
    expect(pool.coinCreator.equals(creator)).toBe(true);
    expect(BONDING_CURVE_CREATOR_OFFSET).toBe(CURVE.creator);
    expect(POOL_COIN_CREATOR_OFFSET).toBe(POOL.coinCreator);
  });

  it('decodes pre-upgrade curves and pools with the new fee buckets as zero', () => {
    const creator = key();
    const curve = PUMP_SDK.decodeBondingCurve(account(curveBytes({ creator, size: 81 }), PUMP_PROGRAM_ID));
    expect(curve.creator.equals(creator)).toBe(true);
    expect(curve.creatorFee.isZero()).toBe(true);
    const pool = PUMP_AMM_SDK.decodePool(account(poolBytes({ baseMint: key(), coinCreator: creator, size: 245 }), PUMP_AMM_PROGRAM_ID));
    expect(pool.coinCreator.equals(creator)).toBe(true);
    expect(pool.creatorFees.isZero()).toBe(true);
  });

  it('ignores bytes a future upgrade appends', () => {
    const creator = key();
    const curve = PUMP_SDK.decodeBondingCurve(account(curveBytes({ creator, creatorFee: 7n, size: 200 }), PUMP_PROGRAM_ID));
    expect(curve.creatorFee.toString()).toBe('7');
    const pool = PUMP_AMM_SDK.decodePool(account(poolBytes({ baseMint: key(), coinCreator: creator, creatorFees: 9n, size: 320 }), PUMP_AMM_PROGRAM_ID));
    expect(pool.creatorFees.toString()).toBe('9');
  });

  it('reads a negative virtual_quote_reserves as negative', () => {
    const pool = PUMP_AMM_SDK.decodePool(account(
      poolBytes({ baseMint: key(), coinCreator: key(), virtualQuoteReserves: -1_500_000n }),
      PUMP_AMM_PROGRAM_ID,
    ));
    expect(pool.virtualQuoteReserves.isNeg()).toBe(true);
    expect(pool.virtualQuoteReserves.toString()).toBe('-1500000');
  });
});

describe('on-chain scans', () => {
  const creator = key();
  const solMint = key();
  const t22Mint = key();
  const usdcQuotedMint = key();
  const idleMint = key();
  const otherCreatorMint = key();
  const graduatedMint = key();

  const curveAt = (mint, fields) => ({ pubkey: bondingCurvePda(mint), account: account(curveBytes(fields), PUMP_PROGRAM_ID) });
  const poolKey = key();
  const programAccounts = [
    curveAt(solMint, { creator, creatorFee: 4_000n, size: 166 }),
    curveAt(t22Mint, { creator, creatorFee: 6_000n, quoteMint: PublicKey.default }),
    curveAt(usdcQuotedMint, { creator, creatorFee: 99_000n, quoteMint: key() }),
    curveAt(idleMint, { creator, size: 81 }),
    curveAt(otherCreatorMint, { creator: key(), creatorFee: 1n }),
    { pubkey: poolKey, account: account(poolBytes({ baseMint: graduatedMint, coinCreator: creator, creatorFees: 10_000n }), PUMP_AMM_PROGRAM_ID) },
    { pubkey: key(), account: account(poolBytes({ baseMint: key(), coinCreator: creator, size: 245 }), PUMP_AMM_PROGRAM_ID) },
  ];
  const tokenAccounts = [
    { owner: bondingCurvePda(solMint), programId: TOKEN_PROGRAM_ID, mint: solMint },
    { owner: bondingCurvePda(t22Mint), programId: TOKEN_2022_PROGRAM_ID, mint: t22Mint },
    { owner: bondingCurvePda(t22Mint), programId: TOKEN_PROGRAM_ID, mint: NATIVE_MINT },
    { owner: bondingCurvePda(usdcQuotedMint), programId: TOKEN_PROGRAM_ID, mint: usdcQuotedMint },
    { owner: bondingCurvePda(idleMint), programId: TOKEN_PROGRAM_ID, mint: idleMint },
  ];

  it('filters by discriminator and creator only, so short and long accounts are both found', async () => {
    const connection = memoryConnection({ programAccounts, tokenAccounts });
    const curves = await scanCreatorCurves(connection, creator);
    expect(curves).toHaveLength(4);
    const pools = await scanCreatorPools(connection, creator);
    expect(pools).toHaveLength(2);
    for (const { config } of connection.calls) expect(config.filters.some((f) => f.dataSize != null)).toBe(false);
  });

  it('resolves a curve to its own mint, including Token-2022 coins, never to its quote token', async () => {
    const connection = memoryConnection({ programAccounts, tokenAccounts });
    expect(await resolveCurveMint(connection, bondingCurvePda(solMint))).toBe(solMint.toBase58());
    expect(await resolveCurveMint(connection, bondingCurvePda(t22Mint))).toBe(t22Mint.toBase58());
    expect(await resolveCurveMint(connection, key())).toBeNull();
  });

  it('lists only non-empty, SOL-paired waiting buckets and totals them', async () => {
    const waiting = await getWaitingCreatorFees(memoryConnection({ programAccounts, tokenAccounts }), creator);
    expect(waiting.curves.map((r) => r.mint).sort()).toEqual([solMint.toBase58(), t22Mint.toBase58()].sort());
    expect(waiting.curveLamports).toBe(10_000);
    expect(waiting.pools).toHaveLength(1);
    expect(waiting.pools[0].mint).toBe(graduatedMint.toBase58());
    expect(waiting.pools[0].address).toBe(poolKey.toBase58());
    expect(waiting.poolLamports).toBe(10_000);
    expect(waiting.lamports).toBe(20_000);
    expect(waiting.curves.every((r) => r.creator === creator.toBase58())).toBe(true);
  });

  it('builds one sweep per bucket, largest first, paid by the payer', async () => {
    const payer = key();
    const waiting = await getWaitingCreatorFees(memoryConnection({ programAccounts, tokenAccounts }), creator);
    const { sweeps, unsweepable } = await buildSweepInstructions(waiting, payer);
    expect(unsweepable).toHaveLength(0);
    expect(sweeps.map((s) => s.lamports)).toEqual([10_000, 6_000, 4_000]);
    expect(sweeps[0].venue).toBe('pool');
    expect(sweeps[0].instruction.programId.equals(PUMP_AMM_PROGRAM_ID)).toBe(true);
    expect(sweeps[1].instruction.programId.equals(PUMP_PROGRAM_ID)).toBe(true);
    for (const { instruction } of sweeps) {
      expect(instruction.keys.some((k) => k.pubkey.equals(payer) && k.isSigner)).toBe(true);
    }
  });

  it('reports a curve whose mint cannot be resolved instead of guessing', async () => {
    const waiting = {
      curves: [{ venue: 'curve', address: key().toBase58(), mint: null, creator: creator.toBase58(), lamports: 5 }],
      pools: [],
    };
    const { sweeps, unsweepable } = await buildSweepInstructions(waiting, key());
    expect(sweeps).toHaveLength(0);
    expect(unsweepable).toEqual([{ venue: 'curve', address: waiting.curves[0].address, mint: null, lamports: 5 }]);
  });
});
