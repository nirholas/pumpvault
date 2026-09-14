# pumpvault

Launch coins on [pump.fun](https://pump.fun), claim the creator fees they earn, and get funds out of a wallet whose key has leaked. Everything runs in the browser: keys are generated locally, encrypted with your passphrase, and never sent anywhere.

```
pumpvault
├─ Wallet   generate a wallet, fund it by QR, see balances and fees
├─ Launch   coin details, image, first buy, one atomic Jito bundle
├─ Claim    every coin a wallet launched, and the fees waiting for it
└─ Rescue   empty an exposed wallet before a sweeper bot does
```

There is no account, no backend database, and no custody. The included server does three jobs only: it serves the static files and forwards three requests the browser is not allowed to make directly.

---

## Why this exists

Three problems, one toolkit:

**Launching needs a funded wallet.** People without a Solana wallet cannot launch a coin at all. pumpvault generates one in the tab, shows a QR code, and tells you exactly how much SOL to send (roughly 0.05 covers a launch). Send funds the way you would top up a Bitrefill voucher, fill in the coin details, and launch.

**Creator fees go unclaimed.** Every pump.fun coin pays its creator a share of trading fees, held in an on-chain vault until somebody claims them. Most creators never look. Point pumpvault at any address to see what it is owed, then claim with the key.

**A leaked key is a race you lose.** Sweeper bots watch known-compromised addresses and take any SOL that lands, often in the same block. You cannot win that race by sending SOL for gas first, because the bot takes the gas. pumpvault's rescue uses a [Jito](https://jito.wtf) bundle: a separate clean wallet pays the fee and the tip, the exposed wallet only signs, and the collect and the transfer land in one atomic transaction. There is no slot in which a balance sits exposed.

## What atomic means here

Every money-moving action is a Jito bundle: a set of transactions that land in one block, in order, with nothing inserted between them, or do not land at all.

| Action | Bundle |
| --- | --- |
| Launch (one wallet) | `create` + tip, one transaction |
| Launch (separate creator) | Tx1: funder sends rent + first buy + tip. Tx2: creator runs `createV2` and pays its own fee, so the creator wallet needs no SOL beforehand |
| Claim | `collectCoinCreatorFee`, optionally followed by a transfer to a safe wallet in the same transaction |
| Rescue | collect fees, drain SOL, and move tokens, all in one bundle, funded by a clean wallet |

A dropped bundle costs nothing but the network fee. A partial rescue never happens.

## Quick start

```bash
git clone https://github.com/nirholas/pumpvault
cd pumpvault
npm install
cp .env.example .env      # optional: set RPC_URL to a paid endpoint
npm run dev               # web app on :5173, proxy on :8787
```

For production:

```bash
npm run build && npm start   # serves dist/ and the proxies on :8787
```

The public RPC works for trying it out. For real launches use a paid endpoint (Helius, Triton, QuickNode); public nodes rate-limit and drop transactions. Set it in `.env` as `RPC_URL` and it stays server-side.

## Using it

**Generate a wallet.** The Wallet page creates a keypair in the tab and asks for a vault passphrase. Back the private key up: it is encrypted in your browser's local storage and nowhere else, so a cleared browser with no backup means a lost wallet.

**Fund it.** Scan the QR with any Solana wallet, or copy the address. A launch needs about 0.03 SOL for rent and fees, plus whatever you want as your first buy.

**Launch.** Fill in the name, ticker, image, and description on the Launch page. The cost panel itemises rent, first buy, tip, and fees before you commit, and the confirmation dialog shows exactly what leaves your wallet. Nothing is signed until you approve it.

**Claim.** The Claim page lists every coin an address launched (from the pump.fun API and an on-chain scan, merged) with the fees waiting. Claim into the same wallet, or send the claim straight to a different one, which is what you want if the key has ever been exposed.

**Rescue.** Pick the compromised wallet, a clean wallet to pay, and a safe destination. pumpvault scans for SOL, unclaimed fees, and token balances, then moves everything in one bundle.

## Fee routing, and why a coin sometimes cannot be claimed

pump.fun sends creator fees to one of three places, and pumpvault labels each coin with which:

- **creator** — the normal case. The creator wallet claims with `collect`.
- **fee sharing** — the coin has a sharing config splitting fees among several shareholders. Anyone can run `distribute`, which pays every shareholder their share; the Claim page offers that instead of a claim button.
- **cashback** — fees go back to traders. There is no creator vault, and nothing to claim.
- **holder rewards** — protocol creator fees accrue to token holders. The creator cannot collect or distribute these fees.

## Command line

The same flows, for servers and scripts:

```bash
npx pumpvault balance --wallet <pubkey>
npx pumpvault coins   --creator <pubkey>
npx pumpvault fees    --creator <pubkey>

CREATOR_SECRET=<base58> npx pumpvault launch \
  --name "Nyan Cat" --symbol NYAN --image ./logo.png --dev-buy 0.02

CREATOR_SECRET=<base58> npx pumpvault claim --to <safe-wallet>

VICTIM_SECRET=<base58> FUNDER_SECRET=<base58> \
  npx pumpvault rescue --to <safe-wallet> --tokens
```

Keys are read from environment variables or keypair files, never from arguments, because other users on a machine can read a process list. Anything that spends prints a summary and waits for confirmation unless you pass `--yes`. Full help: `npx pumpvault --help`.

## Library

Every piece is importable on its own, with no UI attached:

```js
import { Connection, Keypair } from '@solana/web3.js';
import {
  getCreatorVaultLamports, buildCollectInstructions,
  planCollect, executePlan, resolveTipAccount,
} from 'pumpvault';

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const creator = Keypair.fromSecretKey(/* your key */);

const vaultLamports = await getCreatorVaultLamports(connection, creator.publicKey);
if (vaultLamports > 0) {
  const [instructions, tipAccount, balance] = await Promise.all([
    buildCollectInstructions(connection, creator.publicKey, creator.publicKey),
    resolveTipAccount(),
    connection.getBalance(creator.publicKey),
  ]);

  // A plan is inert: it describes the transactions and summarises them for a
  // confirmation screen. Nothing is signed or sent until executePlan runs.
  const plan = planCollect({
    funder: creator, creator, destination: 'YourSafeWallet…',
    collectInstructions: instructions, vaultLamports,
    creatorBalanceLamports: balance, tipLamports: 1_000_000, tipAccount,
  });

  console.log(plan.summary);
  const { bundleId, signatures } = await executePlan(connection, plan);
}
```

Entry points: `pumpvault` (everything), `pumpvault/keys`, `/vault`, `/jito`, `/pump`, `/fees`, `/atomic`. See [docs/library.md](docs/library.md).

## How keys are handled

- Generated in the browser with `crypto.getRandomValues`, via `@solana/web3.js`.
- Encrypted with AES-256-GCM under a key derived from your passphrase by PBKDF2-SHA256 (310,000 iterations), each blob with its own salt and IV.
- Stored encrypted in `localStorage`. The plaintext passphrase is cached in `sessionStorage` so moving between pages does not re-prompt; that cache is per-tab, expires after 15 minutes of inactivity, and is cleared by Lock.
- Never transmitted. Transactions are signed locally and posted straight to Jito's block engine from your browser.
- The server never receives a key, and there is nothing on it to breach.

The honest tradeoffs are in [docs/security.md](docs/security.md), including what the session cache means and what a compromised browser can still do.

## The server

`server/index.mjs` is deliberately small:

| Route | Why it exists |
| --- | --- |
| `POST /api/rpc` | Keeps a paid RPC key server-side rather than shipping it to every visitor |
| `GET /api/pump/*` | pump.fun's API returns 403 to browser origins |
| `POST /api/ipfs` | pump.fun's IPFS upload endpoint sends no CORS headers |

It holds no state and stores nothing. Point it at your own RPC and it is the whole backend.

## Development

```bash
npm run dev     # vite on :5173 with the proxy on :8787
npm test        # vitest
npm run build   # static site into dist/
```

Tests cover the parts where a mistake costs money: secret-key parsing, vault encryption, and every transfer amount the plan builders compute.

## Credits

- Bundle patterns from [nirholas/atomic](https://github.com/nirholas/atomic).
- Interface built on the design language of [nirholas/solana-launchpad-ui](https://github.com/nirholas/solana-launchpad-ui).
- On-chain work through [`@pump-fun/pump-sdk`](https://www.npmjs.com/package/@pump-fun/pump-sdk) and [`@pump-fun/pump-swap-sdk`](https://www.npmjs.com/package/@pump-fun/pump-swap-sdk).


