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
//   vaultLamports: 5000000, drainLamports: 6109120, tipLamports: 1000000 }

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
import { getCreatorVaultLamports, listCreatedCoins, getCoinFeeStatus } from 'pumpvault/fees';

await getCreatorVaultLamports(connection, creator);   // unclaimed lamports
await listCreatedCoins({ connection, creator });      // API + on-chain scan, merged
await getCoinFeeStatus(connection, mint);             // creator | sharing_config | cashback
```

`listCreatedCoins` merges pump.fun's API (rich metadata) with a `getProgramAccounts` scan of bonding curves by creator, so a coin the API has not indexed still appears. Pass `apiBase` to route the API half through a proxy.

`getCoinFeeStatus` decides where fees actually go. A coin with a sharing config is claimed with `buildDistributeInstructions` and `planDistribute`, not with `collect`; a cashback coin has no creator vault at all.

## Full working example

Claim fees and forward them to a safe wallet in one atomic transaction:

```js
import { Connection, Keypair } from '@solana/web3.js';
import { parseSecretKey } from 'pumpvault/keys';
import { getCreatorVaultLamports, buildCollectInstructions } from 'pumpvault/fees';
import { planCollect, executePlan, resolveTipAccount } from 'pumpvault/atomic';
import { lamportsToSol } from 'pumpvault';

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const creator = parseSecretKey(process.env.CREATOR_SECRET);
const destination = process.env.SAFE_WALLET;

const [vaultLamports, creatorBalanceLamports, tipAccount] = await Promise.all([
  getCreatorVaultLamports(connection, creator.publicKey),
  connection.getBalance(creator.publicKey, 'confirmed'),
  resolveTipAccount(),
]);

if (vaultLamports === 0) {
  console.log('Nothing to claim.');
} else {
  const collectInstructions = await buildCollectInstructions(
    connection, creator.publicKey, creator.publicKey,
  );
  const plan = planCollect({
    funder: creator, creator, destination, collectInstructions,
    vaultLamports, creatorBalanceLamports, tipLamports: 1_000_000, tipAccount,
  });

  console.log(`Claiming ${lamportsToSol(vaultLamports)} SOL to ${destination}`);
  const { bundleId, signatures } = await executePlan(connection, plan);
  console.log(`https://explorer.jito.wtf/bundle/${bundleId}`);
  for (const sig of signatures) console.log(`https://solscan.io/tx/${sig}`);
}
```
