---
name: pumpvault-cli
description: Use the pumpvault CLI to read a Solana wallet's balance and pump.fun creator fees, and to launch coins, claim fees or rescue an exposed wallet with Jito bundles. Use when a task involves pump.fun creator fees or emptying a wallet whose key has leaked.
---

# pumpvault CLI

pumpvault is a non-custodial toolkit for pump.fun creators. The CLI (`cli/pumpvault.mjs`, bin name `pumpvault`) runs the same flows as the web app. The package is not published to npm, so run it from a clone. Node 20 or newer is required.

## Install

```bash
git clone https://github.com/nirholas/pumpvault
cd pumpvault
npm install
node cli/pumpvault.mjs --help
```

Below, `pumpvault` means `node cli/pumpvault.mjs` from the clone root.

## Read-only commands (no key needed)

```bash
pumpvault balance --wallet <pubkey>     # SOL balance and unclaimed creator fees
pumpvault coins   --creator <pubkey>    # coins the wallet launched, fee routing, waiting fees
pumpvault fees    --creator <pubkey>    # fees in the vault, on bonding curves, in PumpSwap pools
```

Common options: `--rpc <url>` (default is `RPC_URL`, else mainnet-beta), `--json` for machine output, `--tip <sol>` for the Jito tip, `--yes` to skip the confirmation prompt, `-h`/`--help`.

Use `--json` when you need to parse the result. Prefer a private RPC endpoint through `RPC_URL`; the public mainnet endpoint rate limits.

## Commands that spend

| Command | Needs | Notes |
| --- | --- | --- |
| `launch --name X --symbol Y --image ./logo.png` | `CREATOR_SECRET` | Optional `--description`, `--twitter`, `--telegram`, `--website`, `--dev-buy <sol>`, `--mayhem` or `--holder-reward` (not both), `--funder-secret-env <ENV>` for a separate payer. |
| `claim [--to <pubkey>]` | `CREATOR_SECRET` | Sweeps waiting fees, then collects them, in one atomic Jito bundle. |
| `rescue --to <pubkey> [--tokens]` | `VICTIM_SECRET` and `FUNDER_SECRET` | Empties an exposed wallet. The funder must be a different, clean wallet that pays the fee and tip. `--tokens` also moves token balances. |

Keys are read only from environment variables (base58, a JSON byte array, or a path to a keypair file). Never pass a secret as an argument. Each spending command prints a summary and asks for confirmation. In a non-interactive shell it refuses unless `--yes` is given.

These commands move real funds on mainnet. Show the user the wallet, amount and destination, and wait for an explicit yes before running one with `--yes`.

## Worked example

Check what a creator is owed, then claim it to a safe wallet:

```bash
export RPC_URL=https://your-rpc.example
pumpvault fees --creator <creator-pubkey> --json
CREATOR_SECRET=/path/to/creator.json pumpvault claim --to <safe-wallet>
```

## Library

The package exports `./jito`, `./pump`, `./fees`, `./atomic`, `./keys` and `./vault` from `src/lib/`, so the same logic can be imported without the UI.
