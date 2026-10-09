#!/usr/bin/env node
/**
 * pumpvault CLI: the same launch, claim, and rescue flows the web app runs,
 * for servers and scripts. Keys come from environment variables or keypair
 * files and never leave the machine; transactions go straight to Jito.
 *
 *   pumpvault balance   --wallet <pubkey>
 *   pumpvault coins     --creator <pubkey>
 *   pumpvault fees      --creator <pubkey>
 *   pumpvault launch    --name X --symbol Y --image ./logo.png [--dev-buy 0.02]
 *   pumpvault claim     [--to <pubkey>]
 *   pumpvault rescue    --to <pubkey> [--tokens]
 *
 * Every command that spends prints a summary and waits for confirmation unless
 * --yes is passed.
 */
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { parseSecretKey } from '../src/lib/keys.js';
import {
  buildCreateInstructions, estimateLaunchCost, fetchPumpLookupTables, uploadMetadata,
} from '../src/lib/pump.js';
import {
  buildCollectInstructions, getCoinFeeStatus, getCreatorFeeBreakdown, listCreatedCoins,
} from '../src/lib/fees.js';
import {
  executePlan, listTokenAccounts, mergePlans, planCollect, planDrainSol, planLaunch, planRescueTokens, resolveTipAccount,
} from '../src/lib/atomic.js';
import {
  CREATE_RENT_LAMPORTS, DEFAULT_LAUNCH_TIP_LAMPORTS, DEFAULT_RESCUE_TIP_LAMPORTS, RENT_EXEMPT_MIN_LAMPORTS,
} from '../src/lib/constants.js';
import { lamportsToSol, solToLamports } from '../src/lib/tx.js';

const HELP = `pumpvault: launch pump.fun coins, claim creator fees, rescue exposed wallets.

Commands
  balance   --wallet <pubkey>            SOL balance and unclaimed creator fees
  coins     --creator <pubkey>           coins a wallet launched, with fee routing and waiting fees
  fees      --creator <pubkey>           unclaimed creator fees: vault, waiting on curves, waiting in pools
  launch    --name --symbol --image      launch a coin (needs CREATOR_SECRET)
  claim     [--to <pubkey>]              collect creator fees (needs CREATOR_SECRET)
  rescue    --to <pubkey> [--tokens]     empty an exposed wallet (needs VICTIM_SECRET + FUNDER_SECRET)

Common options
  --rpc <url>          RPC endpoint (default RPC_URL, else mainnet-beta)
  --tip <sol>          Jito tip (default ${lamportsToSol(DEFAULT_LAUNCH_TIP_LAMPORTS)} launching, ${lamportsToSol(DEFAULT_RESCUE_TIP_LAMPORTS)} rescuing)
  --yes                skip the confirmation prompt
  --json               machine-readable output
  -h, --help

Launch options
  --description, --twitter, --telegram, --website
  --dev-buy <sol>      buy your own coin in the create transaction
  --mayhem, --holder-reward   (one or the other; pump.fun no longer creates cashback coins)
  --funder-secret-env  env var holding a separate payer key (default: creator pays)

Keys (base58, JSON byte array, or a path to a keypair file)
  CREATOR_SECRET   the wallet that creates coins and owns their fees
  FUNDER_SECRET    a clean wallet that pays fees and Jito tips
  VICTIM_SECRET    the exposed wallet a rescue empties

Never pass a secret on the command line: other users on the machine can read it
from the process list. Use the environment variables above.`;

function loadKey(name, { required = true } = {}) {
  const raw = process.env[name];
  if (!raw) {
    if (!required) return null;
    fail(`${name} is not set. Export it as a base58 key, a JSON byte array, or a path to a keypair file.`);
  }
  const value = raw.trim();
  if (!value.startsWith('[') && (value.endsWith('.json') || value.includes('/'))) {
    try {
      return parseSecretKey(readFileSync(value, 'utf8'));
    } catch (e) {
      fail(`Could not read the keypair file in ${name}: ${e.message}`);
    }
  }
  try {
    return parseSecretKey(value);
  } catch (e) {
    fail(`${name} is not a usable key: ${e.message}`);
  }
}

const out = { json: false };
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
function say(line) {
  if (!out.json) process.stdout.write(`${line}\n`);
}
function emit(obj) {
  if (out.json) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function confirm(question, skip) {
  if (skip) return true;
  if (!process.stdin.isTTY) fail('Refusing to spend without confirmation. Re-run with --yes in a non-interactive shell.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

function connect(values) {
  return new Connection(values.rpc || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
}

const sol = (l) => `${lamportsToSol(l, 6)} SOL`;

async function run(connection, plan, label) {
  say('');
  const result = await executePlan(connection, plan, {
    onStage: (stage, data) => {
      if (stage === 'simulate') say('Simulating against mainnet...');
      if (stage === 'submit') say('Submitting the Jito bundle...');
      if (stage === 'confirm') say(`Bundle ${data.bundleId} submitted. Waiting for confirmation...`);
    },
  });
  say(`\n${label}`);
  for (const s of result.signatures) say(`  https://solscan.io/tx/${s}`);
  say(`  https://explorer.jito.wtf/bundle/${result.bundleId}`);
  return result;
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdBalance(values) {
  const connection = connect(values);
  const wallet = new PublicKey(values.wallet ?? fail('--wallet is required'));
  const [balance, fees] = await Promise.all([
    connection.getBalance(wallet, 'confirmed'),
    getCreatorFeeBreakdown(connection, wallet),
  ]);
  emit({ wallet: wallet.toBase58(), balanceLamports: balance, ...feeFields(fees) });
  say(`${wallet.toBase58()}\n  balance:         ${sol(balance)}\n  unclaimed fees:  ${sol(fees.totalLamports)}`);
  sayBreakdown(fees);
}

/** JSON fields for a fee breakdown. `unclaimedFeeLamports` is what a claim pays, waiting fees included. */
function feeFields(fees) {
  return {
    unclaimedFeeLamports: fees.totalLamports,
    vaultFeeLamports: fees.vaultLamports,
    waitingCurveFeeLamports: fees.curveLamports,
    waitingPoolFeeLamports: fees.poolLamports,
  };
}

function sayBreakdown(fees) {
  say(`    in vault:                  ${sol(fees.vaultLamports)}`);
  say(`    waiting on curves:         ${sol(fees.curveLamports)}`);
  say(`    waiting in PumpSwap pools: ${sol(fees.poolLamports)}`);
  if (fees.waitingLamports > 0) say('    (waiting fees are swept into the vault by the claim, in the same bundle)');
}

async function cmdCoins(values) {
  const connection = connect(values);
  const creator = new PublicKey(values.creator ?? fail('--creator is required'));
  const coins = await listCreatedCoins({ connection, creator });
  const rows = [];
  for (const coin of coins) {
    const status = await getCoinFeeStatus(connection, coin.mint).catch(() => null);
    rows.push({
      ...coin,
      feeDestination: status?.feeDestination ?? 'unknown',
      isGraduated: status?.isGraduated ?? coin.complete,
      quoteMint: status?.quoteMint ?? null,
      waitingCurveFee: status?.waitingCurveFee ?? null,
      waitingPoolFee: status?.waitingPoolFee ?? null,
    });
  }
  emit({ creator: creator.toBase58(), coins: rows });
  if (!rows.length) return say('No coins found for this wallet.');
  say(`${rows.length} coin(s) launched by ${creator.toBase58()}:`);
  for (const c of rows) {
    const waiting = (c.waitingCurveFee ?? 0) + (c.waitingPoolFee ?? 0);
    const waitingNote = !waiting ? ''
      : c.quoteMint === NATIVE_MINT.toBase58() ? `  ${sol(waiting)} waiting to sweep`
      : `  ${waiting} base units of ${c.quoteMint} waiting to sweep`;
    say(`  ${c.mint}  ${(c.symbol || '?').padEnd(10)} ${c.isGraduated ? 'graduated' : 'bonding  '}  fees -> ${c.feeDestination}${waitingNote}`);
  }
}

async function cmdFees(values) {
  const connection = connect(values);
  const creator = new PublicKey(values.creator ?? fail('--creator is required'));
  const fees = await getCreatorFeeBreakdown(connection, creator);
  emit({ creator: creator.toBase58(), ...feeFields(fees), unclaimedFeeSol: lamportsToSol(fees.totalLamports, 9) });
  say(`${sol(fees.totalLamports)} unclaimed by ${creator.toBase58()}`);
  sayBreakdown(fees);
}

async function cmdLaunch(values) {
  const connection = connect(values);
  const creator = loadKey('CREATOR_SECRET');
  const funder = values['funder-secret-env'] ? loadKey(values['funder-secret-env']) : creator;
  const name = values.name ?? fail('--name is required');
  const symbol = (values.symbol ?? fail('--symbol is required')).toUpperCase();
  const imagePath = values.image ?? fail('--image is required (a PNG, JPG, GIF or WebP file)');
  const devBuyLamports = values['dev-buy'] ? solToLamports(values['dev-buy']) : 0;
  const tipLamports = values.tip ? solToLamports(values.tip) : DEFAULT_LAUNCH_TIP_LAMPORTS;

  const cost = estimateLaunchCost({ devBuyLamports, tipLamports, rentLamports: CREATE_RENT_LAMPORTS });
  const balance = await connection.getBalance(funder.publicKey, 'confirmed');

  say(`Launching ${name} (${symbol})`);
  say(`  creator:       ${creator.publicKey.toBase58()}`);
  say(`  payer:         ${funder.publicKey.toBase58()} (${sol(balance)})`);
  say(`  rent:          ${sol(cost.rentLamports)}`);
  say(`  first buy:     ${sol(cost.devBuyLamports)}`);
  say(`  jito tip:      ${sol(cost.tipLamports)}`);
  say(`  total:         ${sol(cost.totalLamports)}`);
  if (balance < cost.totalLamports) fail(`Payer needs ${sol(cost.totalLamports - balance)} more.`);
  if (!(await confirm('Launch this coin on mainnet?', values.yes))) return say('Cancelled.');

  say('Uploading metadata to IPFS...');
  const { metadataUri } = await uploadMetadata({
    image: { bytes: readFileSync(imagePath), filename: basename(imagePath) },
    name, symbol,
    description: values.description ?? '',
    twitter: values.twitter ?? '',
    telegram: values.telegram ?? '',
    website: values.website ?? '',
  });

  const mint = Keypair.generate();
  const [{ instructions }, lookupTables, tipAccount] = await Promise.all([
    buildCreateInstructions({
      connection, mint: mint.publicKey, name, symbol, uri: metadataUri,
      creator: creator.publicKey, user: creator.publicKey,
      devBuyLamports, mayhemMode: Boolean(values.mayhem), holderReward: Boolean(values['holder-reward']),
    }),
    fetchPumpLookupTables(connection),
    resolveTipAccount(),
  ]);

  const plan = planLaunch({
    funder, creator, mint, createInstructions: instructions, lookupTables,
    devBuyLamports, rentLamports: CREATE_RENT_LAMPORTS, tipLamports, tipAccount,
  });
  const result = await run(connection, plan, `Launched ${name}.`);
  say(`  https://pump.fun/coin/${mint.publicKey.toBase58()}`);
  emit({ mint: mint.publicKey.toBase58(), metadataUri, ...result });
}

async function cmdClaim(values) {
  const connection = connect(values);
  const creator = loadKey('CREATOR_SECRET');
  const funder = values['funder-secret-env'] ? loadKey(values['funder-secret-env']) : creator;
  const destination = values.to ?? null;
  const tipLamports = values.tip ? solToLamports(values.tip) : DEFAULT_LAUNCH_TIP_LAMPORTS;

  const [fees, creatorBalance] = await Promise.all([
    getCreatorFeeBreakdown(connection, creator.publicKey),
    connection.getBalance(creator.publicKey, 'confirmed'),
  ]);
  if (fees.totalLamports <= 0) return say('Nothing to claim.');

  say(`Claiming ${sol(fees.totalLamports)} for ${creator.publicKey.toBase58()}`);
  sayBreakdown(fees);
  if (destination) say(`  forwarding to ${destination} in the same transaction`);
  if (!(await confirm('Claim now?', values.yes))) return say('Cancelled.');

  const [claim, tipAccount, lookupTables] = await Promise.all([
    buildCollectInstructions(connection, creator.publicKey, funder.publicKey),
    resolveTipAccount(),
    fetchPumpLookupTables(connection),
  ]);
  const plan = planCollect({
    ...claim, funder, creator, destination, lookupTables,
    creatorBalanceLamports: creatorBalance, tipLamports, tipAccount,
  });
  sayDeferred(plan.summary);
  const result = await run(connection, plan, `Claimed ${sol(plan.summary.claimLamports)}.`);
  emit({
    claimedLamports: plan.summary.claimLamports,
    sweptLamports: plan.summary.sweptLamports,
    deferredSweeps: plan.summary.deferredSweeps,
    destination: plan.summary.destination,
    ...result,
  });
}

/** Waiting buckets a claim could not fit in one bundle stay where they are for the next claim. */
function sayDeferred(summary) {
  const left = [...summary.deferredSweeps, ...summary.unsweepable];
  if (!left.length) return;
  say(`  ${left.length} waiting fee bucket(s) (${sol(left.reduce((t, r) => t + r.lamports, 0))}) do not fit in this bundle; run the claim again to sweep them.`);
}

async function cmdRescue(values) {
  const connection = connect(values);
  const victim = loadKey('VICTIM_SECRET');
  const funder = loadKey('FUNDER_SECRET');
  const destination = values.to ?? fail('--to is required: the safe wallet that receives everything');
  const tipLamports = values.tip ? solToLamports(values.tip) : DEFAULT_RESCUE_TIP_LAMPORTS;

  if (victim.publicKey.equals(funder.publicKey)) fail('FUNDER_SECRET must be a different wallet from VICTIM_SECRET.');

  const [balance, fees, heldTokens] = await Promise.all([
    connection.getBalance(victim.publicKey, 'confirmed'),
    getCreatorFeeBreakdown(connection, victim.publicKey),
    values.tokens ? listTokenAccounts(connection, victim.publicKey) : Promise.resolve([]),
  ]);
  const vault = fees.totalLamports;
  // A claim unwraps the wallet's wSOL into SOL that the drain moves, so wSOL is not sent as a token too.
  const tokens = vault > 0 ? heldTokens.filter((t) => t.mint !== NATIVE_MINT.toBase58()) : heldTokens;

  say(`Rescuing ${victim.publicKey.toBase58()}`);
  say(`  balance:        ${sol(balance)}`);
  say(`  unclaimed fees: ${sol(vault)}`);
  if (vault > 0) sayBreakdown(fees);
  say(`  tokens:         ${tokens.length}`);
  say(`  destination:    ${destination}`);
  say(`  paid by:        ${funder.publicKey.toBase58()}`);

  const movesSol = balance + vault > RENT_EXEMPT_MIN_LAMPORTS;
  if (!movesSol && !tokens.length) return say('Nothing to rescue.');
  if (!(await confirm('Move everything out now?', values.yes))) return say('Cancelled.');

  const tipAccount = await resolveTipAccount();
  const plans = [];
  let tip = tipLamports;
  const takeTip = () => { const t = tip; tip = 0; return t; };

  if (vault > 0) {
    const [claim, lookupTables] = await Promise.all([
      buildCollectInstructions(connection, victim.publicKey, funder.publicKey),
      fetchPumpLookupTables(connection),
    ]);
    const collectPlan = planCollect({
      ...claim, funder, creator: victim, destination, creatorBalanceLamports: balance, lookupTables,
      // Token transfers take 3 per transaction; sweeps get whatever bundle room is left.
      maxTxs: 5 - Math.ceil(tokens.length / 3),
      tipLamports: takeTip(), tipAccount, keepLamports: RENT_EXEMPT_MIN_LAMPORTS,
    });
    sayDeferred(collectPlan.summary);
    plans.push(collectPlan);
  } else if (movesSol) {
    plans.push(planDrainSol({
      funder, from: victim, destination, balanceLamports: balance,
      keepLamports: RENT_EXEMPT_MIN_LAMPORTS, tipLamports: takeTip(), tipAccount,
    }));
  }
  if (tokens.length) {
    plans.push(planRescueTokens({
      funder, from: victim, destinationOwner: destination, tokens, tipLamports: takeTip(), tipAccount,
    }));
  }

  const result = await run(connection, mergePlans(...plans), `Rescued to ${destination}.`);
  emit({ destination, movedLamports: balance + vault, tokens: tokens.length, ...result });
}

// ── entry ──────────────────────────────────────────────────────────────────

const COMMANDS = { balance: cmdBalance, coins: cmdCoins, fees: cmdFees, launch: cmdLaunch, claim: cmdClaim, rescue: cmdRescue };

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    wallet: { type: 'string' }, creator: { type: 'string' }, to: { type: 'string' },
    name: { type: 'string' }, symbol: { type: 'string' }, image: { type: 'string' },
    description: { type: 'string' }, twitter: { type: 'string' }, telegram: { type: 'string' }, website: { type: 'string' },
    'dev-buy': { type: 'string' }, tip: { type: 'string' }, rpc: { type: 'string' },
    'funder-secret-env': { type: 'string' },
    mayhem: { type: 'boolean' }, 'holder-reward': { type: 'boolean' }, tokens: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];
if (values.help || !command) {
  process.stdout.write(`${HELP}\n`);
  process.exit(command ? 0 : 1);
}
if (!COMMANDS[command]) fail(`Unknown command "${command}". Run pumpvault --help.`);
out.json = Boolean(values.json);

COMMANDS[command](values).catch((e) => fail(e?.message ?? String(e)));
