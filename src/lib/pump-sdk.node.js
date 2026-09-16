// Node entry for the pump.fun SDK. The SDK's ESM build (and its
// @pump-fun/agent-payments-sdk dependency) imports named exports from the
// CommonJS @coral-xyz/anchor, which Node's ESM loader cannot link. Loading the
// SDK's CommonJS build sidesteps that and exposes the identical API.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk');

export const {
  OnlinePumpSdk,
  PUMP_SDK,
  canonicalPumpPoolPda,
  creatorVaultPda,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
  hasCoinCreatorMigratedToSharingConfig,
} = sdk;
