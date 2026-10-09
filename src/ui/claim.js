/** Claim page: list coins a wallet launched, show unclaimed fees, collect them atomically. */
import { PublicKey } from '@solana/web3.js';
import * as store from './store.js';
import { getConnection, getBalanceLamports, PUMP_API_PROXY } from './rpc.js';
import {
  buildCollectInstructions, buildDistributeInstructions, getCoinFeeStatus, getCreatorFeeBreakdown,
  getSharingConfig, getSharingConfigVaultLamports, listCreatedCoins,
} from '../lib/fees.js';
import { executePlan, planCollect, planDistribute, resolveTipAccount } from '../lib/atomic.js';
import { fetchPumpLookupTables } from '../lib/pump.js';
import { isPublicKey, shortAddress } from '../lib/keys.js';
import { solToLamports } from '../lib/tx.js';
import {
  coinAvatar, confirmModal, el, ensureUnlocked, explorerLinks, fmt, formModal, initShell, mount, progressModal, toast, walletSelect,
} from './app.js';

initShell('/claim');
const page = document.getElementById('page');

// `fees` is the creator's breakdown: what the vaults hold plus what still waits on curves and in pools.
const state = { creator: null, signable: false, loading: false, coins: [], fees: null, balance: null, error: null };

const totalFees = () => state.fees?.totalLamports ?? null;

/** The confirm-modal rows that itemise a claim, so a creator sees where every lamport comes from. */
function breakdownRows(fees) {
  return [
    ['In your vault', fmt.sol(fees.vaultLamports)],
    ...(fees.curveLamports ? [['Waiting on bonding curves', fmt.sol(fees.curveLamports)]] : []),
    ...(fees.poolLamports ? [['Waiting in PumpSwap pools', fmt.sol(fees.poolLamports)]] : []),
  ];
}

function tipLamports() {
  return solToLamports(store.getSettings().launchTipSol);
}

async function load() {
  if (!state.creator) return;
  state.loading = true;
  state.error = null;
  render();
  const connection = getConnection();
  const [coins, fees, balance] = await Promise.allSettled([
    listCreatedCoins({ connection, creator: state.creator, apiBase: PUMP_API_PROXY }),
    getCreatorFeeBreakdown(connection, state.creator),
    getBalanceLamports(new PublicKey(state.creator)),
  ]);
  state.coins = coins.status === 'fulfilled' ? coins.value : [];
  state.fees = fees.status === 'fulfilled' ? fees.value : null;
  state.balance = balance.status === 'fulfilled' ? balance.value : null;
  state.error = coins.status === 'rejected' ? coins.reason.message : null;
  state.loading = false;
  render();
  for (const coin of state.coins) hydrateCoin(coin);
}

/** Per-coin fee routing is only knowable on chain; fill it in after the list paints. */
async function hydrateCoin(coin) {
  try {
    const status = await getCoinFeeStatus(getConnection(), coin.mint);
    coin.status = status;
    if (status.hasSharingConfig) {
      const [pending, config] = await Promise.all([
        getSharingConfigVaultLamports(getConnection(), coin.mint).catch(() => null),
        getSharingConfig(getConnection(), coin.mint).catch(() => null),
      ]);
      coin.sharingPending = pending;
      coin.sharingConfig = config;
    }
  } catch (e) {
    coin.statusError = e.message;
  }
  render();
}

async function claimAll() {
  if (!(await ensureUnlocked())) return;
  const creatorKp = store.getKeypair(state.creator);
  const fees = state.fees;
  if (!fees || fees.totalLamports <= 0) return toast('Nothing to claim yet', 'err');

  const values = await formModal({
    title: 'Claim creator fees',
    intro: 'Claiming first sweeps the fees still waiting on your bonding curves and PumpSwap pools into your vaults, then collects every coin this wallet created, all in one atomic bundle.',
    fields: [
      { name: 'destination', label: 'Send to (optional)', placeholder: 'Leave empty to keep the SOL in this wallet', mono: true,
        hint: 'Set a destination and the SOL moves out in the same transaction, so a sweeper bot never sees a balance to take.' },
    ],
    submitLabel: 'Review',
  });
  if (!values) return;

  const destination = values.destination?.trim() || null;
  if (destination && !isPublicKey(destination)) return toast('That destination is not a valid Solana address', 'err');

  const walletMeta = store.getWallet(state.creator);
  const feeLamports = tipLamports();
  const ok = await confirmModal({
    title: 'Claim these fees?',
    intro: destination ? 'Fees are collected and forwarded in one atomic transaction.' : 'Fees are collected into the creator wallet.',
    rows: [
      ['Creator wallet', state.creator],
      ...breakdownRows(fees),
      ['Unclaimed fees', fmt.sol(fees.totalLamports), 'total'],
      ['Destination', destination || `${state.creator} (stays here)`],
      ['Jito tip', fmt.sol(feeLamports)],
    ],
    confirmLabel: 'Claim now',
    note: walletMeta?.compromised && !destination
      ? 'This wallet is flagged as compromised. Set a destination so the SOL leaves in the same transaction.'
      : undefined,
  });
  if (!ok) return;

  const progress = progressModal('Claiming creator fees', [
    { key: 'build', label: 'Building the sweep and collect transactions' },
    { key: 'simulate', label: 'Simulating against mainnet' },
    { key: 'submit', label: 'Submitting the Jito bundle' },
    { key: 'confirm', label: 'Waiting for confirmation' },
  ]);

  try {
    progress.stage('build');
    const connection = getConnection();
    // The creator pays its own fee unless it is being drained; then the drain must
    // cover the tip too, which the plan accounts for via its fee reserve.
    const [claim, tipAccount, creatorBalance, lookupTables] = await Promise.all([
      buildCollectInstructions(connection, state.creator, state.creator),
      resolveTipAccount(),
      getBalanceLamports(creatorKp.publicKey),
      fetchPumpLookupTables(connection, { cluster: store.getSettings().cluster }),
    ]);

    const plan = planCollect({
      ...claim,
      funder: creatorKp,
      creator: creatorKp,
      destination,
      lookupTables,
      creatorBalanceLamports: creatorBalance,
      tipLamports: feeLamports,
      tipAccount,
      priorityMicroLamports: store.getSettings().priorityMicroLamports,
    });

    const { bundleId, signatures } = await executePlan(connection, plan, {
      onStage: (stage, data) => {
        if (stage === 'simulate') progress.stage('simulate');
        if (stage === 'submit') progress.stage('submit');
        if (stage === 'confirm') progress.stage('confirm', `Bundle ${data.bundleId.slice(0, 12)}… submitted`);
      },
    });

    const left = plan.summary.deferredSweeps.length + plan.summary.unsweepable.length;
    progress.done(el('div', { class: 'stack', style: 'gap:12px' },
      el('div', { class: 'callout ok' }, destination
        ? `Claimed ${fmt.sol(plan.summary.drainLamports)} and sent it to ${shortAddress(destination, 6)}.`
        : `Claimed ${fmt.sol(plan.summary.claimLamports)} into ${shortAddress(state.creator, 6)}.`),
      left ? el('div', { class: 'callout info' },
        `${left} smaller waiting ${left === 1 ? 'bucket' : 'buckets'} did not fit in this bundle and still ${left === 1 ? 'holds' : 'hold'} ${fmt.sol(plan.summary.deferredLamports + plan.summary.unsweepable.reduce((t, r) => t + r.lamports, 0))}. Claim again to sweep ${left === 1 ? 'it' : 'them'}.`) : null,
      explorerLinks({ signatures, bundleId })));
    toast('Fees claimed');
    load();
  } catch (e) {
    progress.fail(e.message);
  }
}

async function distribute(coin) {
  if (!(await ensureUnlocked())) return;
  const payerPubkey = store.getActivePubkey();
  if (!payerPubkey) return toast('Add a wallet to pay the network fee', 'err');

  const waiting = waitingLamports(coin);
  const ok = await confirmModal({
    title: 'Distribute shared fees?',
    intro: 'This coin routes fees through a sharing config. Distributing sweeps the fees still waiting on its curve and pool, then pays every shareholder their split; anyone may pay the fee to run it.',
    rows: [
      ['Coin', `${coin.name || coin.mint} ${coin.symbol ? `(${coin.symbol})` : ''}`],
      ['Pending in vault', coin.sharingPending != null ? fmt.sol(coin.sharingPending) : 'unknown'],
      ...(waiting ? [['Waiting to sweep', fmt.sol(waiting)]] : []),
      ...(coin.sharingConfig?.shareholders ?? []).map((s) => [`${(s.bps / 100).toFixed(2)}% to`, shortAddress(s.address, 6)]),
      ['Paid by', payerPubkey],
      ['Jito tip', fmt.sol(tipLamports())],
    ],
    confirmLabel: 'Distribute',
  });
  if (!ok) return;

  const progress = progressModal('Distributing shared fees', [
    { key: 'build', label: 'Building the distribute transaction' },
    { key: 'simulate', label: 'Simulating against mainnet' },
    { key: 'submit', label: 'Submitting the Jito bundle' },
    { key: 'confirm', label: 'Waiting for confirmation' },
  ]);

  try {
    progress.stage('build');
    const connection = getConnection();
    const funder = store.getKeypair(payerPubkey);
    const [{ instructions, sweepCount }, tipAccount, lookupTables] = await Promise.all([
      buildDistributeInstructions(connection, coin.mint, funder.publicKey, { quoteMint: coin.status?.quoteMint }),
      resolveTipAccount(),
      fetchPumpLookupTables(connection, { cluster: store.getSettings().cluster }),
    ]);
    const plan = planDistribute({
      funder, mint: coin.mint, distributeInstructions: instructions, sweepCount, lookupTables,
      vaultLamports: coin.sharingPending ?? 0, waitingLamports: waiting, tipLamports: tipLamports(), tipAccount,
      priorityMicroLamports: store.getSettings().priorityMicroLamports,
    });
    const { bundleId, signatures } = await executePlan(connection, plan, {
      onStage: (stage, data) => {
        if (stage === 'simulate') progress.stage('simulate');
        if (stage === 'submit') progress.stage('submit');
        if (stage === 'confirm') progress.stage('confirm', `Bundle ${data.bundleId.slice(0, 12)}… submitted`);
      },
    });
    progress.done(el('div', { class: 'stack', style: 'gap:12px' },
      el('div', { class: 'callout ok' }, 'Shared fees distributed to every shareholder.'),
      explorerLinks({ signatures, bundleId })));
    toast('Fees distributed');
    load();
  } catch (e) {
    progress.fail(e.message);
  }
}

/** SOL a coin's trades left on its curve and in its pool, waiting to be swept. 0 for non-SOL pairs. */
function waitingLamports(coin) {
  if (!coin.status?.isSolQuote) return 0;
  return coin.status.waitingCurveFee + coin.status.waitingPoolFee;
}

function feeBadge(coin) {
  if (coin.statusError) return el('span', { class: 'badge', title: coin.statusError }, 'status unavailable');
  if (!coin.status) return el('span', { class: 'skeleton', style: 'display:inline-block;width:110px;height:18px' });
  const { feeDestination, isGraduated } = coin.status;
  return el('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' },
    isGraduated ? el('span', { class: 'badge purple' }, 'graduated') : el('span', { class: 'badge cyan' }, 'bonding curve'),
    feeDestination === 'creator' ? el('span', { class: 'badge green' }, 'fees to you')
      : feeDestination === 'sharing_config' ? el('span', { class: 'badge yellow' }, 'fee sharing')
      : feeDestination === 'holder_rewards' ? el('span', { class: 'badge purple' }, 'holder rewards')
      : el('span', { class: 'badge' }, 'cashback coin'));
}

function coinRow(coin) {
  return el('div', { class: 'coin-row fade-in' },
    coinAvatar({ image: coin.image, symbol: coin.symbol, mint: coin.mint }),
    el('div', {},
      el('div', { class: 'coin-name' }, coin.name || 'Unnamed coin', coin.symbol ? el('span', { class: 'badge' }, coin.symbol) : null),
      el('div', { class: 'coin-meta' },
        el('span', { class: 'mono' }, shortAddress(coin.mint, 5)),
        coin.createdAt ? el('span', {}, new Date(coin.createdAt).toLocaleDateString()) : null,
        coin.usdMarketCap ? el('span', {}, `$${Math.round(coin.usdMarketCap).toLocaleString()} mcap`) : null,
        el('a', { href: `https://pump.fun/coin/${coin.mint}`, target: '_blank', rel: 'noopener' }, 'pump.fun'),
        coin.source === 'chain' ? el('span', { class: 'dim', title: 'Found on chain; pump.fun has not indexed it' }, 'on-chain only') : null,
        waitingLamports(coin) ? el('span', {
          class: 'badge yellow',
          title: 'Fees from recent trades that are still on the bonding curve or in the PumpSwap pool. A claim or distribute sweeps them in first.',
        }, `${fmt.sol(waitingLamports(coin))} waiting to sweep`) : null)),
    el('div', { class: 'coin-side' },
      feeBadge(coin),
      coin.status?.hasSharingConfig
        ? el('button', { class: 'btn btn-outline btn-sm', onClick: () => distribute(coin) },
            coin.sharingPending || waitingLamports(coin)
              ? `Distribute ${fmt.sol((coin.sharingPending ?? 0) + waitingLamports(coin))}`
              : 'Distribute')
        : null));
}

function summaryCard() {
  const total = totalFees();
  const fees = state.fees;
  const claimable = total != null && total > 0;
  return el('aside', { class: `card ${claimable ? 'accent' : ''}`, style: 'position:sticky;top:calc(var(--header-h) + 20px)' },
    el('div', { class: 'card-title' }, 'Unclaimed creator fees'),
    el('div', { class: 'stat' },
      el('span', { class: 'stat-value', style: claimable ? 'color:var(--green)' : '' },
        state.loading && total == null ? el('span', { class: 'skeleton', style: 'display:inline-block;width:140px;height:26px' })
          : total == null ? 'unavailable' : fmt.sol(total, 6)),
      el('span', { class: 'stat-label', style: 'margin-top:6px' }, 'Across every coin this wallet created')),
    fees ? el('dl', { class: 'kv', style: 'margin-top:16px' },
      el('dt', {}, 'In your vault'), el('dd', {}, fmt.sol(fees.vaultLamports, 6)),
      el('dt', { title: 'Fees from recent bonding-curve trades that wait on each curve until swept' }, 'Waiting on bonding curves'),
      el('dd', {}, fmt.sol(fees.curveLamports, 6)),
      el('dt', { title: 'Fees from recent PumpSwap trades that wait in each pool until swept' }, 'Waiting in PumpSwap pools'),
      el('dd', {}, fmt.sol(fees.poolLamports, 6))) : null,
    fees?.waitingLamports ? el('div', { class: 'form-hint', style: 'margin-top:8px' },
      'Waiting fees are not in your vault yet. Claiming sweeps them in and collects them in the same bundle.') : null,
    el('dl', { class: 'kv', style: 'margin-top:16px' },
      el('dt', {}, 'Wallet'), el('dd', {}, shortAddress(state.creator ?? '', 6)),
      el('dt', {}, 'Balance'), el('dd', {}, state.balance == null ? 'unknown' : fmt.sol(state.balance)),
      el('dt', {}, 'Coins found'), el('dd', {}, String(state.coins.length))),
    state.signable
      ? el('button', { class: 'btn btn-primary btn-lg', style: 'margin-top:16px', disabled: !claimable, onClick: claimAll },
          claimable ? `Claim ${fmt.sol(total)}` : 'Nothing to claim')
      : el('div', { class: 'callout info', style: 'margin-top:16px' },
          'Read-only: this address is not in your vault. Import its private key on the Wallet page to claim.'),
    claimable && state.signable ? el('div', { class: 'form-hint', style: 'margin-top:10px' },
      'You can send the claim straight to a different wallet, which is the safe move if this key has ever been exposed.') : null);
}

function render() {
  const wallets = store.listWallets();
  const selector = el('div', { class: 'card', style: 'margin-bottom:20px' },
    el('div', { class: 'row spread' },
      el('div', { style: 'flex:1;min-width:240px' },
        el('label', { class: 'form-label', for: 'creator' }, 'Creator wallet'),
        el('div', { id: 'creator-host' })),
      el('div', { class: 'row', style: 'align-items:flex-end;gap:8px' },
        el('button', { class: 'btn btn-outline', onClick: () => onCheckAddress() }, 'Check any address'),
        el('button', { class: 'btn btn-ghost', onClick: load, disabled: !state.creator }, 'Refresh'))));

  mount(page,
    el('h1', { class: 'page-title' }, 'Claim creator fees'),
    el('p', { class: 'page-subtitle' }, "Every coin you launch on pump.fun earns you a cut of its trading fees. They build up on chain, on each coin's bonding curve or PumpSwap pool and in your creator vault, until you claim them. Point this at a wallet to see what it is owed."),
    selector,
    state.creator
      ? el('div', { class: 'grid grid-side' },
          el('section', { class: 'card' },
            el('div', { class: 'card-title' }, 'Coins this wallet launched',
              state.coins.length ? el('span', { class: 'badge' }, String(state.coins.length)) : null),
            state.loading
              ? el('div', { class: 'coin-list' }, [0, 1, 2].map(() => el('div', { class: 'skeleton', style: 'height:72px' })))
              : state.error
                ? el('div', { class: 'callout danger' }, state.error)
                : state.coins.length
                  ? el('div', { class: 'coin-list' }, state.coins.map(coinRow))
                  : el('div', { class: 'empty' },
                      el('h3', {}, 'No coins from this wallet'),
                      el('p', {}, 'Launch one and its fees will show up here.'),
                      el('a', { class: 'btn btn-primary', style: 'margin-top:14px', href: '/launch' }, 'Launch a coin'))),
          summaryCard())
      : el('div', { class: 'empty' },
          el('h3', {}, wallets.length ? 'Pick a wallet' : 'No wallets yet'),
          el('p', {}, wallets.length ? 'Choose one above to see the coins it launched.' : 'Add a wallet, or check any address read-only.'),
          el('div', { class: 'row', style: 'justify-content:center;margin-top:14px' },
            el('a', { class: 'btn btn-primary', href: '/' }, 'Go to wallets'),
            el('button', { class: 'btn btn-outline', onClick: () => onCheckAddress() }, 'Check any address'))),
  );

  const host = document.getElementById('creator-host');
  if (host) {
    const sel = walletSelect({ selected: state.creator, allowNone: true, id: 'creator' });
    if (state.creator && !wallets.some((w) => w.pubkey === state.creator)) {
      sel.append(el('option', { value: state.creator, selected: true }, `${shortAddress(state.creator, 6)} · watch only`));
    }
    sel.addEventListener('change', () => {
      state.creator = sel.value || null;
      state.signable = wallets.some((w) => w.pubkey === state.creator);
      state.coins = []; state.fees = null;
      load();
    });
    mount(host,sel);
  }
}

async function onCheckAddress() {
  const values = await formModal({
    title: 'Check any address',
    intro: 'See the coins an address launched and the fees waiting for it. Claiming needs its private key.',
    fields: [{ name: 'address', label: 'Solana address', required: true, mono: true, placeholder: 'Creator wallet address' }],
    submitLabel: 'Look up',
  });
  if (!values) return;
  const address = values.address.trim();
  if (!isPublicKey(address)) return toast('That is not a valid Solana address', 'err');
  state.creator = address;
  state.signable = store.listWallets().some((w) => w.pubkey === address);
  state.coins = []; state.fees = null;
  load();
}

const initial = new URLSearchParams(location.search).get('wallet') || store.getActivePubkey();
if (initial && isPublicKey(initial)) {
  state.creator = initial;
  state.signable = store.listWallets().some((w) => w.pubkey === initial);
  load();
} else {
  render();
}
store.subscribe(() => { state.signable = store.listWallets().some((w) => w.pubkey === state.creator); });
