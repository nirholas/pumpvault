import { PublicKey } from '@solana/web3.js';
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurvePda,
  canonicalPumpPoolPdaWithQuote,
  creatorVaultPda,
  feeSharingConfigPda,
  hasCoinCreatorMigratedToSharingConfig,
  normalizeQuoteMint,
} from '#pump-sdk';
import {
  PUMP_AMM_SDK,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
} from '@pump-fun/pump-swap-sdk';
import {
  BONDING_CURVE_CREATOR_OFFSET,
  BONDING_CURVE_DISCRIMINATOR,
  POOL_COIN_CREATOR_OFFSET,
  POOL_DISCRIMINATOR,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  RENT_EXEMPT_MIN_LAMPORTS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
} from './constants.js';
import { fetchCoin, fetchCoinsByCreator } from './pump.js';

/*
 * Since the October 2026 Pump / PumpSwap upgrade, creator fees from the new trade
 * instructions (Pump `buy_v3` / `sell_v3`, PumpSwap `buy_v2` / `sell_v2`, multi-hop
 * swaps) are not paid into the creator vault on every trade. They wait on the bonding
 * curve (`BondingCurve.creatorFee`) and in the pool (`Pool.creatorFees`) until someone
 * runs the permissionless `sweep_creator_fee` on that program. A collect only sees what
 * the vaults hold, so every claim here sweeps the waiting buckets first, and every
 * balance shown includes them. Only SOL-paired buckets are handled: the claim collects
 * SOL, and a coin paired with another quote mint pays its creator in that token.
 */

const CONCURRENCY = 8;

const toLamports = (bn) => Number(bn.toString());
const sum = (rows) => rows.reduce((total, r) => total + r.lamports, 0);
const isSolQuote = (quoteMint) => normalizeQuoteMint(quoteMint).equals(NATIVE_MINT);

async function mapLimited(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    out.push(...await Promise.all(items.slice(i, i + CONCURRENCY).map(fn)));
  }
  return out;
}

/** Decode each scanned account, skipping any that do not parse as the expected type. */
function decodeAll(accounts, decode) {
  const rows = [];
  for (const { pubkey, account } of accounts) {
    let decoded;
    try {
      decoded = decode(account);
    } catch {
      continue;
    }
    rows.push({ address: pubkey, decoded });
  }
  return rows;
}

/** Lamports a creator vault PDA holds above its rent-exempt floor (the part a collect pays out). */
const vaultSurplus = (info) => (info ? Math.max(0, info.lamports - RENT_EXEMPT_MIN_LAMPORTS) : 0);

/** Token amount of an SPL token account, or 0 when it does not exist. */
function tokenAmount(info) {
  if (!info) return 0;
  const data = new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  return Number(AccountLayout.decode(data).amount);
}

/** The AMM coin-creator vault's wSOL ATA, where PumpSwap creator fees for `creator` collect. */
function ammVaultAta(creator) {
  return coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(creator), NATIVE_MINT, TOKEN_PROGRAM_ID);
}

/**
 * Creator fees already in the vaults, in lamports: the bonding-curve vault PDA's surplus
 * plus the AMM vault's wSOL ATA. This is what a collect pays out right now; fees still
 * waiting on curves and in pools come from `getWaitingCreatorFees`, and
 * `getCreatorFeeBreakdown` adds the two. Both vaults are read directly rather than through
 * `getCreatorVaultBalanceBothPrograms`, which logs a console warning for every wallet
 * whose AMM vault has never been created.
 */
export async function getCreatorVaultLamports(connection, creator) {
  const creatorPk = new PublicKey(creator);
  const [vaultInfo, ammInfo] = await connection.getMultipleAccountsInfo([creatorVaultPda(creatorPk), ammVaultAta(creatorPk)]);
  return vaultSurplus(vaultInfo) + tokenAmount(ammInfo);
}

/**
 * Every bonding curve whose `creator` is `creator`, decoded with the SDK. The filter
 * matches the BondingCurve discriminator and the creator field, never the account size,
 * so curves written before and after the upgrade (which appended fields) are both found.
 * @returns {Promise<Array<{address: PublicKey, curve: object}>>}
 */
export async function scanCreatorCurves(connection, creator) {
  const accounts = await connection.getProgramAccounts(PUMP_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: BONDING_CURVE_DISCRIMINATOR } },
      { memcmp: { offset: BONDING_CURVE_CREATOR_OFFSET, bytes: new PublicKey(creator).toBase58() } },
    ],
  });
  return decodeAll(accounts, (a) => PUMP_SDK.decodeBondingCurve(a))
    .map(({ address, decoded }) => ({ address, curve: decoded }));
}

/**
 * Every PumpSwap pool whose `coin_creator` is `creator`, decoded with pump-swap-sdk's
 * `decodePool`, which reads pre-upgrade (shorter) pools with the new fields as zero.
 * @returns {Promise<Array<{address: PublicKey, pool: object}>>}
 */
export async function scanCreatorPools(connection, creator) {
  const accounts = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR } },
      { memcmp: { offset: POOL_COIN_CREATOR_OFFSET, bytes: new PublicKey(creator).toBase58() } },
    ],
  });
  return decodeAll(accounts, (a) => PUMP_AMM_SDK.decodePool(a))
    .map(({ address, decoded }) => ({ address, pool: decoded }));
}

/**
 * The mint of a bonding curve, from the token accounts the curve owns. A curve owns its
 * coin's account (SPL Token or Token-2022, depending on how the coin was created) and,
 * when paired with a token, a quote account too, so the mint is the one whose curve PDA
 * is this curve.
 * @returns {Promise<string|null>} base58 mint, or null when it cannot be resolved
 */
export async function resolveCurveMint(connection, curveAddress) {
  const curve = new PublicKey(curveAddress);
  const results = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(
    (programId) => connection.getParsedTokenAccountsByOwner(curve, { programId }),
  ));
  for (const { value } of results) {
    for (const { account } of value) {
      const mint = account.data.parsed?.info?.mint;
      if (mint && bondingCurvePda(new PublicKey(mint)).equals(curve)) return mint;
    }
  }
  return null;
}

/** Every bonding curve whose on-chain creator is `creator`, resolved to mint addresses. */
export async function listCreatedMintsOnChain(connection, creator) {
  const curves = await scanCreatorCurves(connection, creator);
  const mints = await mapLimited(curves, ({ address }) => resolveCurveMint(connection, address));
  return mints.filter(Boolean);
}

/**
 * Creator fees for `creator` that are not in a vault yet: SOL left on bonding curves by
 * v3 trades and in PumpSwap pools by v2 trades. A claim sweeps them in first.
 * Each row is `{ venue: 'curve'|'pool', address, mint, creator, lamports }`; pool rows
 * also carry the decoded `pool`, which the PumpSwap sweep instruction is built from.
 */
export async function getWaitingCreatorFees(connection, creator) {
  const [curves, pools] = await Promise.all([scanCreatorCurves(connection, creator), scanCreatorPools(connection, creator)]);
  const waitingCurves = curves.filter(({ curve }) => isSolQuote(curve.quoteMint) && !curve.creatorFee.isZero());
  const curveMints = await mapLimited(waitingCurves, ({ address }) => resolveCurveMint(connection, address));
  const curveRows = waitingCurves.map(({ address, curve }, i) => ({
    venue: 'curve',
    address: address.toBase58(),
    mint: curveMints[i],
    creator: curve.creator.toBase58(),
    lamports: toLamports(curve.creatorFee),
  }));
  const poolRows = pools
    .filter(({ pool }) => pool.quoteMint.equals(NATIVE_MINT) && !pool.creatorFees.isZero())
    .map(({ address, pool }) => ({
      venue: 'pool',
      address: address.toBase58(),
      mint: pool.baseMint.toBase58(),
      creator: pool.coinCreator.toBase58(),
      lamports: toLamports(pool.creatorFees),
      pool,
    }));
  return {
    curves: curveRows,
    pools: poolRows,
    curveLamports: sum(curveRows),
    poolLamports: sum(poolRows),
    lamports: sum(curveRows) + sum(poolRows),
  };
}

/**
 * Everything a creator can claim, itemised: what the vaults hold now, and what is still
 * waiting on curves and in pools. `totalLamports` is what a claim (which sweeps first) pays.
 */
export async function getCreatorFeeBreakdown(connection, creator) {
  const [vaultLamports, waiting] = await Promise.all([
    getCreatorVaultLamports(connection, creator),
    getWaitingCreatorFees(connection, creator),
  ]);
  return {
    vaultLamports,
    curveLamports: waiting.curveLamports,
    poolLamports: waiting.poolLamports,
    waitingLamports: waiting.lamports,
    totalLamports: vaultLamports + waiting.lamports,
    waiting,
  };
}

/**
 * `sweep_creator_fee` instructions for the waiting buckets from `getWaitingCreatorFees`,
 * largest first. A curve sweep pays `creatorVaultPda(curve creator)`, a pool sweep pays
 * the AMM coin-creator vault of the pool's own `coin_creator`. A curve whose mint could
 * not be resolved cannot be swept and is returned in `unsweepable`.
 * Each sweep: `{ venue, mint, address, lamports, instruction }`.
 */
export async function buildSweepInstructions(waiting, payer) {
  const payerPk = new PublicKey(payer);
  const sweeps = [];
  const unsweepable = [];
  for (const row of waiting.curves) {
    if (!row.mint) {
      unsweepable.push({ venue: row.venue, address: row.address, mint: null, lamports: row.lamports });
      continue;
    }
    const instruction = await PUMP_SDK.sweepCreatorFeeInstruction({
      payer: payerPk, mint: new PublicKey(row.mint), creator: new PublicKey(row.creator), quoteMint: NATIVE_MINT,
    });
    sweeps.push({ venue: 'curve', mint: row.mint, address: row.address, lamports: row.lamports, instruction });
  }
  for (const row of waiting.pools) {
    const instruction = await PUMP_AMM_SDK.sweepCreatorFeeInstruction({
      payer: payerPk, poolKey: new PublicKey(row.address), pool: row.pool, quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    sweeps.push({ venue: 'pool', mint: row.mint, address: row.address, lamports: row.lamports, instruction });
  }
  sweeps.sort((a, b) => b.lamports - a.lamports);
  return { sweeps, unsweepable };
}

/**
 * Everything a claim needs, for `planCollect`. Permissionless: anyone can pay; the SOL
 * always lands in the creator wallet.
 *
 * - `collectInstructions`: the SDK's SOL collect from both vaults. When someone other
 *   than the creator pays, the SDK leaves the PumpSwap fees as wSOL in the creator's
 *   ATA, so a close is appended that unwraps them into the creator's SOL balance.
 * - `sweeps`: `sweep_creator_fee` for every waiting SOL bucket, largest first. They must
 *   land before the collect (the planner orders them), or those fees stay where they are.
 * - `vaultLamports`: what the vaults hold now. Each sweep adds its `lamports` on top.
 * - `vaultTopUpLamports`: rent the payer may add to the bonding-curve vault when a curve
 *   sweep lands in a vault that is not rent exempt yet (a creator with only v3 fees).
 * - `ataRentLamports`: rent for the AMM vault's wSOL ATA, which the collect (or a pool
 *   sweep) creates at the payer's cost when it does not exist yet.
 * - `unwrapLamports`: SOL the creator gains from the close (the wSOL ATA's own lamports).
 */
export async function buildCollectInstructions(connection, creator, feePayer) {
  const creatorPk = new PublicKey(creator);
  const payerPk = new PublicKey(feePayer);
  const paidByCreator = payerPk.equals(creatorPk);
  const creatorWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, creatorPk, true, TOKEN_PROGRAM_ID);
  const sdk = new OnlinePumpSdk(connection);
  const [collect, waiting, [vaultInfo, ammInfo, creatorWsolInfo]] = await Promise.all([
    sdk.collectCoinCreatorFeeInstructions(creatorPk, payerPk),
    getWaitingCreatorFees(connection, creatorPk),
    connection.getMultipleAccountsInfo([creatorVaultPda(creatorPk), ammVaultAta(creatorPk), creatorWsolAta]),
  ]);
  const { sweeps, unsweepable } = await buildSweepInstructions(waiting, payerPk);
  const collectInstructions = paidByCreator
    ? collect
    : [...collect, createCloseAccountInstruction(creatorWsolAta, creatorPk, creatorPk)];
  return {
    collectInstructions,
    sweeps,
    unsweepable,
    vaultLamports: vaultSurplus(vaultInfo) + tokenAmount(ammInfo),
    vaultTopUpLamports: Math.max(0, RENT_EXEMPT_MIN_LAMPORTS - (vaultInfo?.lamports ?? 0)),
    ataRentLamports: ammInfo ? 0 : TOKEN_ACCOUNT_RENT_LAMPORTS,
    unwrapLamports: paidByCreator ? 0 : (creatorWsolInfo?.lamports ?? TOKEN_ACCOUNT_RENT_LAMPORTS),
  };
}

function normaliseCoin(c, source) {
  return {
    mint: c.mint,
    name: c.name || '',
    symbol: c.symbol || '',
    image: c.image_uri || '',
    description: c.description || '',
    complete: Boolean(c.complete),
    pool: c.pump_swap_pool || null,
    marketCapSol: c.market_cap != null ? Number(c.market_cap) : null,
    usdMarketCap: c.usd_market_cap != null ? Number(c.usd_market_cap) : null,
    createdAt: c.created_timestamp ? Number(c.created_timestamp) : null,
    source,
  };
}

/**
 * Coins launched by a wallet: pump.fun's API (rich metadata) merged with an
 * on-chain scan (catches anything the API has not indexed or hides).
 */
export async function listCreatedCoins({ connection, creator, apiBase, fetchImpl }) {
  const creatorStr = new PublicKey(creator).toBase58();
  const [apiResult, chainResult] = await Promise.allSettled([
    fetchCoinsByCreator(creatorStr, { apiBase, fetchImpl }),
    listCreatedMintsOnChain(connection, creatorStr),
  ]);
  if (apiResult.status === 'rejected' && chainResult.status === 'rejected') {
    throw new Error(`Could not list coins: ${apiResult.reason?.message}; ${chainResult.reason?.message}`);
  }
  const byMint = new Map();
  for (const c of apiResult.value ?? []) byMint.set(c.mint, normaliseCoin(c, 'api'));
  const missing = (chainResult.value ?? []).filter((m) => !byMint.has(m));
  const details = await Promise.all(missing.map((m) => fetchCoin(m, { apiBase, fetchImpl }).catch(() => null)));
  missing.forEach((mint, i) => {
    byMint.set(mint, details[i] ? normaliseCoin(details[i], 'chain') : { mint, name: '', symbol: '', image: '', complete: false, pool: null, createdAt: null, source: 'chain' });
  });
  return [...byMint.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * Where a coin's creator fees go, who can collect them, and what is still waiting to be
 * swept: `waitingCurveFee` (on the bonding curve) and `waitingPoolFee` (in the PumpSwap
 * pool), in base units of `quoteMint` (lamports for a SOL-paired coin).
 */
export async function getCoinFeeStatus(connection, mint) {
  const mintPk = new PublicKey(mint);
  const sdk = new OnlinePumpSdk(connection);
  const bondingCurve = await sdk.fetchBondingCurve(mintPk);
  const quoteMint = normalizeQuoteMint(bondingCurve.quoteMint);
  let creator = new PublicKey(bondingCurve.creator);
  let isCashback = Boolean(bondingCurve.isCashbackCoin);
  let isHolderReward = Boolean(bondingCurve.isHolderReward);

  const poolInfo = await connection.getAccountInfo(canonicalPumpPoolPdaWithQuote(mintPk, quoteMint));
  // A pool account that does not decode yet is still being migrated; the curve's creator stands.
  const pool = poolInfo ? PUMP_AMM_SDK.decodePoolNullable(poolInfo) : null;
  if (pool) {
    creator = new PublicKey(pool.coinCreator);
    isCashback = isCashback || Boolean(pool.isCashbackCoin);
    isHolderReward = isHolderReward || Boolean(pool.isHolderReward);
  }
  const hasSharingConfig = !isCashback && !isHolderReward && hasCoinCreatorMigratedToSharingConfig({ mint: mintPk, creator });
  let feeDestination = 'creator';
  if (isHolderReward) feeDestination = 'holder_rewards';
  else if (isCashback) feeDestination = 'cashback';
  else if (hasSharingConfig) feeDestination = 'sharing_config';
  return {
    mint: mintPk.toBase58(),
    creator: creator.toBase58(),
    quoteMint: quoteMint.toBase58(),
    isSolQuote: quoteMint.equals(NATIVE_MINT),
    isGraduated: Boolean(poolInfo),
    isCashback,
    isHolderReward,
    hasSharingConfig,
    feeDestination,
    waitingCurveFee: toLamports(bondingCurve.creatorFee),
    waitingPoolFee: pool ? toLamports(pool.creatorFees) : 0,
  };
}

/** Creator fees parked under a coin's fee-sharing config vaults (claimed with `distribute`, not `collect`). */
export async function getSharingConfigVaultLamports(connection, mint) {
  return getCreatorVaultLamports(connection, feeSharingConfigPda(new PublicKey(mint)));
}

/** Shareholders and admin of a coin's fee-sharing config, or null when it has none. */
export async function getSharingConfig(connection, mint) {
  const address = feeSharingConfigPda(new PublicKey(mint));
  const info = await connection.getAccountInfo(address);
  if (!info) return null;
  const cfg = PUMP_SDK.decodeSharingConfig(info);
  return {
    address: address.toBase58(),
    admin: cfg.admin.toBase58(),
    shareholders: cfg.shareholders.map((s) => ({ address: s.address.toBase58(), bps: Number(s.share) })),
  };
}

/**
 * Permissionless crank that pays every shareholder their split. The SDK puts the curve
 * and pool `sweep_creator_fee` first (the first `sweepCount` instructions): distribution
 * refuses an un-swept curve bucket (6095 `CreatorFeesNotSwept`), and the pool sweep is
 * only included when a `payer` is given, so one is always passed here. `quoteMint` is
 * the coin's quote (`getCoinFeeStatus(...).quoteMint`); omitted means SOL.
 */
export async function buildDistributeInstructions(connection, mint, payer, { quoteMint } = {}) {
  const sdk = new OnlinePumpSdk(connection);
  const { instructions, isGraduated, sweepCount } = await sdk.buildDistributeCreatorFeesInstructions(new PublicKey(mint), {
    payer: new PublicKey(payer),
    ...(quoteMint ? { quoteMint: new PublicKey(quoteMint) } : {}),
  });
  return { instructions, isGraduated, sweepCount };
}
