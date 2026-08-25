import { PublicKey } from '@solana/web3.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Rent-exempt minimum for a 0-byte system account. Left behind on every drain. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880;

/** pump.fun bonding-curve program. */
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/** pump.fun AMM (PumpSwap) program. */
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/** Byte offset of the `creator` pubkey inside a BondingCurve account (8 disc + 5 u64 + 1 bool). */
export const BONDING_CURVE_CREATOR_OFFSET = 49;

/** Address lookup tables pump.fun publishes for create+buy transactions. */
export const PUMP_ALT_MAINNET = new PublicKey('7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe');
export const PUMP_ALT_DEVNET = new PublicKey('7y3623xaVQzsLxHRyp1wQD4Pmer5JjgbaagGFAEqCjua');

export const PUMP_API_BASE = 'https://frontend-api-v3.pump.fun';
export const PUMP_IPFS_ENDPOINT = 'https://pump.fun/api/ipfs';

/** Jito block engines. The first is the global anycast; the rest are regional fallbacks. */
export const JITO_BLOCK_ENGINES = [
  'https://mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://london.mainnet.block-engine.jito.wtf',
  'https://slc.mainnet.block-engine.jito.wtf',
  'https://singapore.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];

/** Snapshot of `getTipAccounts` (2026-08-25). Refreshed live by `fetchTipAccounts`; used only if that call fails. */
export const JITO_TIP_ACCOUNTS_FALLBACK = [
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
];

/** Compute budgets, aligned with pump.fun's frontend constants. */
export const CU_CREATE = 270_000;
export const CU_BUY = 120_000;
export const CU_COLLECT = 200_000;
export const CU_TRANSFER = 20_000;

/** Default priority fee (micro-lamports per CU). */
export const DEFAULT_PRIORITY_MICROLAMPORTS = 500_000;

/** SOL a launch needs on top of the dev buy: mint + metadata + curve rent, plus fees. Measured 0.02 to 0.03 on mainnet. */
export const CREATE_RENT_LAMPORTS = 30_000_000;

/** Default Jito tips. Rescues race sweeper bots, so they tip more. */
export const DEFAULT_LAUNCH_TIP_LAMPORTS = 1_000_000;
export const DEFAULT_RESCUE_TIP_LAMPORTS = 5_000_000;

export const MAX_TX_BYTES = 1232;
