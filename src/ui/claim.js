/** Claim page: list coins a wallet launched, show unclaimed fees, collect them atomically. */
import { PublicKey } from '@solana/web3.js';
import * as store from './store.js';
import { getConnection, getBalanceLamports, PUMP_API_PROXY } from './rpc.js';
import {
  buildCollectInstructions, buildDistributeInstructions, getCoinFeeStatus, getCreatorVaultLamports,
  getSharingConfig, getSharingConfigVaultLamports, listCreatedCoins,
} from '../lib/fees.js';
import { executePlan, planCollect, planDistribute, resolveTipAccount } from '../lib/atomic.js';
import { isPublicKey, shortAddress } from '../lib/keys.js';
import { solToLamports } from '../lib/tx.js';
import {
  coinAvatar, confirmModal, el, ensureUnlocked, explorerLinks, fmt, formModal, initShell, mount, progressModal, toast, walletSelect,
} from './app.js';

initShell('/claim');
const page = document.getElementById('page');

const state = { creator: null, signable: false, loading: false, coins: [], vault: null, balance: null, error: null };

function tipLamports() {
  return solToLamports(store.getSettings().launchTipSol);
}

async function load() {
  if (!state.creator) return;
  state.loading = true;
  state.error = null;
  render();
  const connection = getConnection();
  const [coins, vault, balance] = await Promise.allSettled([
    listCreatedCoins({ connection, creator: state.creator, apiBase: PUMP_API_PROXY }),
    getCreatorVaultLamports(connection, state.creator),
    getBalanceLamports(new PublicKey(state.creator)),
  ]);
  state.coins = coins.status === 'fulfilled' ? coins.value : [];
  state.vault = vault.status === 'fulfilled' ? vault.value : null;
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
  const vault = state.vault ?? 0;
  if (vault <= 0) return toast('Nothing to claim yet', 'err');

  const values = await formModal({
    title: 'Claim creator fees',
    intro: 'Collecting sweeps every coin this wallet created, on the bonding curve and on the AMM, in one transaction.',
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
      ['Unclaimed fees', fmt.sol(vault), 'total'],
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
    { key: 'build', label: 'Building the collect transaction' },
    { key: 'simulate', label: 'Simulating against mainnet' },
    { key: 'submit', label: 'Submitting the Jito bundle' },
    { key: 'confirm', label: 'Waiting for confirmation' },
  ]);

  try {
    progress.stage('build');
    const connection = getConnection();
    // The creator pays its own fee unless it is being drained; then the drain must
    // cover the tip too, which the plan accounts for via its fee reserve.
    const [collectInstructions, tipAccount, creatorBalance] = await Promise.all([
      buildCollectInstructions(connection, state.creator, state.creator),
      resolveTipAccount(),
      getBalanceLamports(creatorKp.publicKey),
    ]);

    const plan = planCollect({
      funder: creatorKp,
      creator: creatorKp,
      destination,
      collectInstructions,
      vaultLamports: vault,
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

    progress.done(el('div', { class: 'stack', style: 'gap:12px' },
      el('div', { class: 'callout ok' }, destination
        ? `Claimed ${fmt.sol(plan.summary.drainLamports)} and sent it to ${shortAddress(destination, 6)}.`
        : `Claimed ${fmt.sol(vault)} into ${shortAddress(state.creator, 6)}.`),
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

  const ok = await confirmModal({
    title: 'Distribute shared fees?',
    intro: 'This coin routes fees through a sharing config. Distributing pays every shareholder their split; anyone may pay the fee to run it.',
    rows: [
      ['Coin', `${coin.name || coin.mint} ${coin.symbol ? `(${coin.symbol})` : ''}`],
      ['Pending in vault', coin.sharingPending != null ? fmt.sol(coin.sharingPending) : 'unknown'],
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
    const [{ instructions }, tipAccount] = await Promise.all([
      buildDistributeInstructions(connection, coin.mint),
      resolveTipAccount(),
    ]);
    const plan = planDistribute({
      funder, mint: coin.mint, distributeInstructions: instructions,
      vaultLamports: coin.sharingPending ?? 0, tipLamports: tipLamports(), tipAccount,
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
        coin.source === 'chain' ? el('span', { class: 'dim', title: 'Found on chain; pump.fun has not indexed it' }, 'on-chain only') : null)),
    el('div', { class: 'coin-side' },
      feeBadge(coin),
      coin.status?.hasSharingConfig
        ? el('button', { class: 'btn btn-outline btn-sm', onClick: () => distribute(coin) },
            coin.sharingPending ? `Distribute ${fmt.sol(coin.sharingPending)}` : 'Distribute')
        : null));
}

function summaryCard() {
  const vault = state.vault;
  const claimable = vault != null && vault > 0;
  return el('aside', { class: `card ${claimable ? 'accent' : ''}`, style: 'position:sticky;top:calc(var(--header-h) + 20px)' },
    el('div', { class: 'card-title' }, 'Unclaimed creator fees'),
    el('div', { class: 'stat' },
      el('span', { class: 'stat-value', style: claimable ? 'color:var(--green)' : '' },
        state.loading && vault == null ? el('span', { class: 'skeleton', style: 'display:inline-block;width:140px;height:26px' })
          : vault == null ? 'unavailable' : fmt.sol(vault, 6)),
      el('span', { class: 'stat-label', style: 'margin-top:6px' }, 'Across every coin this wallet created')),
    el('dl', { class: 'kv', style: 'margin-top:16px' },
      el('dt', {}, 'Wallet'), el('dd', {}, shortAddress(state.creator ?? '', 6)),
      el('dt', {}, 'Balance'), el('dd', {}, state.balance == null ? '—' : fmt.sol(state.balance)),
      el('dt', {}, 'Coins found'), el('dd', {}, String(state.coins.length))),
    state.signable
      ? el('button', { class: 'btn btn-primary btn-lg', style: 'margin-top:16px', disabled: !claimable, onClick: claimAll },
          claimable ? `Claim ${fmt.sol(vault)}` : 'Nothing to claim')
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
    el('p', { class: 'page-subtitle' }, 'Every coin you launch on pump.fun earns you a cut of its trading fees. They sit in an on-chain vault until someone claims them. Point this at a wallet to see what it is owed.'),
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
      state.coins = []; state.vault = null;
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
  state.coins = []; state.vault = null;
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
