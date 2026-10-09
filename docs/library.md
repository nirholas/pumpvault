# Library reference

`pumpvault` is usable without its interface. Every module runs in both Node 20+ and the browser.

```bash
npm install pumpvault
```

| Import | What it holds |
| --- | --- |
| `pumpvault` | everything below |
| `pumpvault/keys` | parsing and formatting keys and addresses |
| `pumpvault/vault` | passphrase encryption for secrets |
| `pumpvault/jito` | tip accounts, bundle submission, bundle status |
| `pumpvault/pump` | metadata upload, coin lookups, create instructions |
| `pumpvault/fees` | creator fees, launched coins, fee routing |
| `pumpvault/atomic` | plan builders and the executor |

## The plan model

Anything that moves money is built in two steps.

1. A **planner** (`planLaunch`, `planCollect`, `planDrainSol`, `planRescueTokens`, `planDistribute`) returns `{ summary, txs }`. It is inert: no signing, no network, no spending. `summary` holds the exact amounts, which is what a confirmation screen should display.
2. **`executePlan`** signs every transaction against one fresh blockhash, simulates, submits the bundle, and waits for confirmation.

Splitting them means the amount a user approves is the amount that gets signed.

```js
const plan = planCollect({ /* … */ });
console.log(plan.summary);
// { kind: 'collect', creator: '…', destination: '…',
//   vaultLamports: 5000000, sweptLamports: 1200000, claimLamports: 6200000,
//   sweeps: [{ venue: 'curve', mint: '…', lamports: 1200000 }], deferredSweeps: [],
//   drainLamports: 7304120, tipLamports: 1000000, … }

const { bundleId, signatures } = await executePlan(connection, plan, {
  onStage: (stage) => console.log(stage),   // blockhash, simulate, submit, confirm, poll
});
```

`mergePlans(...plans)` combines planners into one bundle (five transactions maximum). Only the first plan should carry a tip; pass `tipLamports: 0` to the rest.

## keys

```js
import { parseSecretKey, isPublicKey, shortAddress } from 'pumpvault/keys';

parseSecretKey('5Kd…');                       // base58, 64 bytes
parseSecretKey('[12,34,…]');                  // solana-keygen JSON
parseSecretKey('0xab…');                      // hex
parseSecretKey(seed58, { allowSeed: true });  // 32-byte seed, opt-in only
```

A bare 32-byte value is refused by default: a public key is also 32 bytes, and accepting one silently would derive a wallet the user does not own.

## vault

```js
import { encryptSecret, decryptSecret } from 'pumpvault/vault';

const blob = await encryptSecret(keypair.secretKey, 'a long passphrase');
const bytes = await decryptSecret(blob, 'a long passphrase'); // throws 'Wrong passphrase'
```

AES-256-GCM with PBKDF2-SHA256. The blob is JSON-safe and carries its own salt, IV, and iteration count.

## jito

```js
import { fetchTipAccounts, pickTipAccount, sendBundle, getBundleStatuses } from 'pumpvault/jito';

const tipAccount = pickTipAccount(await fetchTipAccounts());
const { bundleId, endpoint } = await sendBundle([signedTx1, signedTx2]);
```

`fetchTipAccounts` reads the live list and falls back to a pinned snapshot. `sendBundle` tries every block engine region in order and stops at the first acceptance; a 4xx that is not rate limiting stops the loop, since no region will accept a rejected bundle.

## pump

```js
import { uploadMetadata, buildCreateInstructions, fetchCoin, estimateLaunchCost } from 'pumpvault/pump';

const { metadataUri } = await uploadMetadata({ image, name: 'Nyan Cat', symbol: 'NYAN' });
const { instructions } = await buildCreateInstructions({
  connection, mint: mintKeypair.publicKey, name: 'Nyan Cat', symbol: 'NYAN',
  uri: metadataUri, creator: creator.publicKey, user: creator.publicKey,
  devBuyLamports: 20_000_000,
});
```

In a browser, point `uploadMetadata` at your own proxy (`{ endpoint: '/api/ipfs' }`); pump.fun's upload endpoint sends no CORS headers.

## fees

```js
import {
  getCreatorFeeBreakdown, getCreatorVaultLamports, getWaitingCreatorFees,
  listCreatedCoins, getCoinFeeStatus,
} from 'pumpvault/fees';

await getCreatorFeeBreakdown(connection, creator);
// { vaultLamports, curveLamports, poolLamports, waitingLamports, totalLamports, waiting }
await getCreatorVaultLamports(connection, creator);   // in the vaults now (Pump vault + PumpSwap wSOL vault)
await getWaitingCreatorFees(connection, creator);     // { curves, pools, curveLamports, poolLamports, lamports }
await listCreatedCoins({ connection, creator });      // API + on-chain scan, merged
await getCoinFeeStatus(connection, mint);             // feeDestination, quoteMint, waitingCurveFee, waitingPoolFee, …
```

### Fees waiting on the curve and in the pool

Since the October 2026 Pump and PumpSwap upgrade, creator fees from the new trade instructions (Pump `buy_v3` / `sell_v3`, PumpSwap `buy_v2` / `sell_v2`, multi-hop swaps) wait on the coin instead of landing in the creator vault: in `BondingCurve.creator_fee` before graduation and in `Pool.creator_fees` after. The permissionless `sweep_creator_fee` instruction (one on Pump for the curve, one on PumpSwap for the pool) moves them into the creator vault, and `collect` and `distribute` only pay out what has been swept.

`getCreatorFeeBreakdown` is the number to show a creator. `vaultLamports` is what the vaults hold now, `curveLamports` and `poolLamports` are what still waits, and `totalLamports` is what a claim pays, because every claim sweeps first. Label the parts separately: a creator whose fees are all waiting has an empty vault but a non-zero claim.

`getWaitingCreatorFees` finds the waiting buckets with two `getProgramAccounts` scans (bonding curves by `creator`, pools by `coin_creator`). The filters match the account discriminator and the creator field, never the account size, so accounts written before the upgrade (shorter) and after it (longer) are both found, and every account is decoded with the SDK decoder, which reads the older layout with the new fields as zero. Only SOL-paired coins are counted; a coin paired with USDC or another pump coin keeps its creator fee in that mint.

`getCoinFeeStatus` decides where fees actually go and reports `waitingCurveFee` and `waitingPoolFee` in base units of the coin's `quoteMint`. A coin with a sharing config is claimed with `buildDistributeInstructions` and `planDistribute`, not with `collect`; cashback and holder-reward coins have no creator vault to claim. pump.fun no longer creates cashback coins, and `buildCreateInstructions` does not offer the option.

`listCreatedCoins` merges pump.fun's API (rich metadata) with a `getProgramAccounts` scan of bonding curves by creator, so a coin the API has not indexed still appears. Pass `apiBase` to route the API half through a proxy.

### Claiming

```js
import { buildCollectInstructions, buildDistributeInstructions } from 'pumpvault/fees';

const claim = await buildCollectInstructions(connection, creator, payer);
// { collectInstructions, sweeps, unsweepable, vaultLamports,
//   vaultTopUpLamports, ataRentLamports, unwrapLamports }

const { instructions, isGraduated, sweepCount } =
  await buildDistributeInstructions(connection, mint, payer, { quoteMint });
```

`buildCollectInstructions` returns everything `planCollect` needs, so spread it in: `planCollect({ ...claim, funder, creator, destination, creatorBalanceLamports, tipLamports, tipAccount, lookupTables })`. `sweeps` holds one `sweep_creator_fee` per non-zero waiting bucket, largest first. `planCollect` puts as many as fit (1232 bytes, with `fetchPumpLookupTables` supplying pump.fun's address lookup table) in the claim transaction itself and the rest in sweep-only transactions ahead of it in the same bundle. Anything that does not fit in `maxTxs` transactions (default 5) is reported in `summary.deferredSweeps` and is picked up by the next claim. `summary.sweptLamports` is what the sweeps add and `summary.claimLamports` is the vault plus the sweeps. When `payer` is not the creator, the collect leaves the PumpSwap fees as wSOL in the creator's token account, so a close that unwraps them is appended.

`buildDistributeInstructions` needs a `payer`: the SDK's distribute builder puts the curve sweep and, with a payer, the pool sweep first (the first `sweepCount` instructions), because distribution refuses an un-swept curve bucket. Pass `sweepCount` on to `planDistribute`, which keeps everything in one transaction when it fits and moves the sweeps to a transaction just ahead of the distribute otherwise.

## Full working example

Sweep the waiting fees, claim, and forward everything to a safe wallet in one atomic bundle:

```js
import { Connection, Keypair } from '@solana/web3.js';
import { parseSecretKey } from 'pumpvault/keys';
import { getCreatorFeeBreakdown, buildCollectInstructions } from 'pumpvault/fees';
import { fetchPumpLookupTables } from 'pumpvault/pump';
import { planCollect, executePlan, resolveTipAccount } from 'pumpvault/atomic';
import { lamportsToSol } from 'pumpvault';

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const creator = parseSecretKey(process.env.CREATOR_SECRET);
const destination = process.env.SAFE_WALLET;

const [fees, creatorBalanceLamports, tipAccount] = await Promise.all([
  getCreatorFeeBreakdown(connection, creator.publicKey),
  connection.getBalance(creator.publicKey, 'confirmed'),
  resolveTipAccount(),
]);

if (fees.totalLamports === 0) {
  console.log('Nothing to claim.');
} else {
  const [claim, lookupTables] = await Promise.all([
    buildCollectInstructions(connection, creator.publicKey, creator.publicKey),
    fetchPumpLookupTables(connection),
  ]);
  const plan = planCollect({
    ...claim, lookupTables, funder: creator, creator, destination,
    creatorBalanceLamports, tipLamports: 1_000_000, tipAccount,
  });

  console.log(`Claiming ${lamportsToSol(plan.summary.claimLamports)} SOL to ${destination}`);
  for (const s of plan.summary.deferredSweeps) console.log(`Left for the next claim: ${s.mint}`);
  const { bundleId, signatures } = await executePlan(connection, plan);
  console.log(`https://explorer.jito.wtf/bundle/${bundleId}`);
  for (const sig of signatures) console.log(`https://solscan.io/tx/${sig}`);
}
```
