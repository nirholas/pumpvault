import { PublicKey } from '@solana/web3.js';
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  creatorVaultPda,
  feeSharingConfigPda,
  canonicalPumpPoolPda,
  hasCoinCreatorMigratedToSharingConfig,
} from '@pump-fun/pump-sdk';
import {
  OnlinePumpAmmSdk,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
} from '@pump-fun/pump-swap-sdk';
import { RENT_EXEMPT_MIN_LAMPORTS } from './constants.js';
import { BONDING_CURVE_CREATOR_OFFSET, PUMP_PROGRAM_ID } from './constants.js';
import { fetchCoin, fetchCoinsByCreator } from './pump.js';

/**
 * Unclaimed creator fees in lamports: the bonding-curve vault PDA plus the AMM
 * vault's wSOL ATA. Both accounts are read directly rather than through
 * `getCreatorVaultBalanceBothPrograms`, because that helper logs a console
 * warning for every wallet whose AMM vault has never been created, which is the
 * normal state for a wallet that has not earned AMM fees yet.
 */
export async function getCreatorVaultLamports(connection, creator) {
  const creatorPk = new PublicKey(creator);
  const vault = creatorVaultPda(creatorPk);
  const ammVaultAta = coinCreatorVaultAtaPda(
    coinCreatorVaultAuthorityPda(creatorPk),
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
  );
  const [vaultInfo, ammInfo] = await connection.getMultipleAccountsInfo([vault, ammVaultAta]);

  // The vault PDA must stay rent exempt, so only the surplus is collectable.
  let total = 0;
  if (vaultInfo) total += Math.max(0, vaultInfo.lamports - RENT_EXEMPT_MIN_LAMPORTS);
  if (ammInfo) {
    const data = new Uint8Array(ammInfo.data.buffer, ammInfo.data.byteOffset, ammInfo.data.byteLength);
    total += Number(AccountLayout.decode(data).amount);
  }
  return total;
}

/** Permissionless crank: anyone can pay the fee; the SOL always lands in the creator wallet. */
export async function buildCollectInstructions(connection, creator, feePayer) {
  const sdk = new OnlinePumpSdk(connection);
  return sdk.collectCoinCreatorFeeInstructions(new PublicKey(creator), new PublicKey(feePayer));
}

/** Every bonding curve whose on-chain creator is `creator`, resolved to mint addresses. */
export async function listCreatedMintsOnChain(connection, creator) {
  const curves = await connection.getProgramAccounts(PUMP_PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ memcmp: { offset: BONDING_CURVE_CREATOR_OFFSET, bytes: new PublicKey(creator).toBase58() } }],
  });
  const mints = [];
  const batch = 8;
  for (let i = 0; i < curves.length; i += batch) {
    const slice = curves.slice(i, i + batch);
    const found = await Promise.all(slice.map(async ({ pubkey }) => {
      const { value } = await connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });
      return value[0]?.account.data.parsed?.info?.mint ?? null;
    }));
    mints.push(...found.filter(Boolean));
  }
  return mints;
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

/** Where a coin's creator fees go, and who can collect them. */
export async function getCoinFeeStatus(connection, mint) {
  const mintPk = new PublicKey(mint);
  const sdk = new OnlinePumpSdk(connection);
  const bondingCurve = await sdk.fetchBondingCurve(mintPk);
  let creator = new PublicKey(bondingCurve.creator);
  let isGraduated = false;
  let isCashback = Boolean(bondingCurve.isCashbackCoin);

  const poolPda = canonicalPumpPoolPda(mintPk);
  const poolInfo = await connection.getAccountInfo(poolPda);
  if (poolInfo) {
    isGraduated = true;
    try {
      const pool = await new OnlinePumpAmmSdk(connection).fetchPool(poolPda);
      creator = new PublicKey(pool.coinCreator);
      isCashback = isCashback || Boolean(pool.isCashbackCoin);
    } catch {
      /* pool account exists but is still migrating; bonding-curve creator stands */
    }
  }
  const hasSharingConfig = !isCashback && hasCoinCreatorMigratedToSharingConfig({ mint: mintPk, creator });
  return {
    mint: mintPk.toBase58(),
    creator: creator.toBase58(),
    isGraduated,
    isCashback,
    hasSharingConfig,
    feeDestination: isCashback ? 'cashback' : hasSharingConfig ? 'sharing_config' : 'creator',
  };
}

/** Creator fees parked under a coin's fee-sharing config (claimed with `distribute`, not `collect`). */
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

/** Permissionless crank that pays every shareholder their split. */
export async function buildDistributeInstructions(connection, mint) {
  const sdk = new OnlinePumpSdk(connection);
  const { instructions, isGraduated } = await sdk.buildDistributeCreatorFeesInstructions(new PublicKey(mint));
  return { instructions, isGraduated };
}
