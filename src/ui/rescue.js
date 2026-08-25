/**
 * Rescue page: get everything out of a wallet whose key is exposed.
 * A sweeper bot watching that address wins any race where the wallet holds a
 * balance for even one slot, so every rescue here is a Jito bundle: a separate
 * funder pays the fee and tip, and the compromised wallet only ever signs.
 */
import { PublicKey } from '@solana/web3.js';
import * as store from './store.js';
import { getBalanceLamports, getConnection } from './rpc.js';
import { getCreatorVaultLamports, buildCollectInstructions } from '../lib/fees.js';
import {
  executePlan, listTokenAccounts, mergePlans, planCollect, planDrainSol, planRescueTokens, resolveTipAccount,
} from '../lib/atomic.js';
import { isPublicKey, shortAddress } from '../lib/keys.js';
import { solToLamports } from '../lib/tx.js';
import { RENT_EXEMPT_MIN_LAMPORTS } from '../lib/constants.js';
import {
  confirmModal, el, ensureUnlocked, explorerLinks, fmt, initShell, mount, progressModal, toast, walletSelect,
} from './app.js';

initShell('/rescue');
const page = document.getElementById('page');

const state = {
  victim: null, funder: null, destination: '',
  balance: null, vault: null, tokens: [], selected: new Set(),
  loading: false, error: null, scanned: false,
};

const tipLamports = () => solToLamports(store.getSettings().rescueTipSol);

async function scan() {
  if (!state.victim) return;
  state.loading = true;
  state.error = null;
  render();
  const connection = getConnection();
  const victim = new PublicKey(state.victim);
  const [balance, vault, tokens] = await Promise.allSettled([
    getBalanceLamports(victim),
    getCreatorVaultLamports(connection, victim),
    listTokenAccounts(connection, victim),
  ]);
  state.balance = balance.status === 'fulfilled' ? balance.value : null;
  state.vault = vault.status === 'fulfilled' ? vault.value : null;
  state.tokens = tokens.status === 'fulfilled' ? tokens.value : [];
  state.selected = new Set(state.tokens.map((t) => t.mint));
  state.error = [balance, vault, tokens].filter((r) => r.status === 'rejected').map((r) => r.reason.message)[0] ?? null;
  state.loading = false;
  state.scanned = true;
  render();
}

function selectedTokens() {
  return state.tokens.filter((t) => state.selected.has(t.mint));
}

async function rescue() {
  if (!(await ensureUnlocked())) return;
  if (!state.funder) return toast('Pick a clean wallet to pay the fee and tip', 'err');
  if (!isPublicKey(state.destination)) return toast('Enter a valid destination address', 'err');
  if (state.funder === state.victim) return toast('The funder must be a different wallet from the compromised one', 'err');

  const victimKp = store.getKeypair(state.victim);
  const funderKp = store.getKeypair(state.funder);
  const tokens = selectedTokens();
  const vault = state.vault ?? 0;
  const balance = state.balance ?? 0;
  const hasSol = balance > RENT_EXEMPT_MIN_LAMPORTS || vault > 0;
  if (!hasSol && !tokens.length) return toast('Nothing left to rescue in this wallet', 'err');

  const tip = tipLamports();
  const ok = await confirmModal({
    title: 'Rescue this wallet?',
    intro: 'Everything below moves in one atomic Jito bundle. Either all of it lands, or none of it does and only network fees are spent.',
    rows: [
      ['Compromised wallet', state.victim],
      ['Destination', state.destination],
      ['Fee + tip paid by', state.funder],
      vault > 0 ? ['Creator fees collected', fmt.sol(vault)] : null,
      hasSol ? ['SOL moved', fmt.sol(Math.max(0, balance + vault - RENT_EXEMPT_MIN_LAMPORTS))] : null,
      tokens.length ? ['Token types moved', String(tokens.length)] : null,
      ['Jito tip', fmt.sol(tip)],
    ].filter(Boolean),
    confirmLabel: 'Rescue now',
    danger: true,
    note: 'Double-check the destination. Sending to an address you do not control loses the funds permanently.',
  });
  if (!ok) return;

  const progress = progressModal('Rescuing the wallet', [
    { key: 'build', label: 'Building the rescue bundle' },
    { key: 'simulate', label: 'Simulating against mainnet' },
    { key: 'submit', label: 'Submitting the Jito bundle' },
    { key: 'confirm', label: 'Waiting for confirmation' },
  ]);

  try {
    progress.stage('build');
    const connection = getConnection();
    const tipAccount = await resolveTipAccount();
    const plans = [];

    // The first transaction in the bundle carries the tip; the rest ride along.
    let tipForNext = tip;
    const takeTip = () => { const t = tipForNext; tipForNext = 0; return t; };

    if (vault > 0) {
      const collectInstructions = await buildCollectInstructions(connection, state.victim, state.funder);
      plans.push(planCollect({
        funder: funderKp, creator: victimKp, destination: state.destination,
        collectInstructions, vaultLamports: vault, creatorBalanceLamports: balance,
        tipLamports: takeTip(), tipAccount, keepLamports: RENT_EXEMPT_MIN_LAMPORTS,
        priorityMicroLamports: store.getSettings().priorityMicroLamports,
      }));
    } else if (balance > RENT_EXEMPT_MIN_LAMPORTS) {
      plans.push(planDrainSol({
        funder: funderKp, from: victimKp, destination: state.destination,
        balanceLamports: balance, keepLamports: RENT_EXEMPT_MIN_LAMPORTS,
        tipLamports: takeTip(), tipAccount,
        priorityMicroLamports: store.getSettings().priorityMicroLamports,
      }));
    }

    if (tokens.length) {
      plans.push(planRescueTokens({
        funder: funderKp, from: victimKp, destinationOwner: state.destination,
        tokens, tipLamports: takeTip(), tipAccount,
        priorityMicroLamports: store.getSettings().priorityMicroLamports,
      }));
    }

    const plan = mergePlans(...plans);
    const { bundleId, signatures } = await executePlan(connection, plan, {
      onStage: (stage, data) => {
        if (stage === 'simulate') progress.stage('simulate');
        if (stage === 'submit') progress.stage('submit');
        if (stage === 'confirm') progress.stage('confirm', `Bundle ${data.bundleId.slice(0, 12)}… submitted`);
      },
    });

    progress.done(el('div', { class: 'stack', style: 'gap:12px' },
      el('div', { class: 'callout ok' }, `Rescued to ${shortAddress(state.destination, 6)}. Stop using the compromised key: anything sent to it later is still exposed.`),
      explorerLinks({ signatures, bundleId })));
    toast('Rescue confirmed');
    scan();
  } catch (e) {
    progress.fail(e.message);
  }
}

function tokenRow(t) {
  const checked = state.selected.has(t.mint);
  return el('label', { class: 'token-row' },
    el('input', { type: 'checkbox', checked, style: 'accent-color:var(--green);width:16px;height:16px',
      onChange: (e) => { if (e.target.checked) state.selected.add(t.mint); else state.selected.delete(t.mint); render(); } }),
    el('div', {},
      el('div', { class: 'mono', style: 'font-size:13px' }, shortAddress(t.mint, 6)),
      el('div', { class: 'coin-meta' },
        el('span', {}, `${t.uiAmount} tokens`),
        el('a', { href: `https://pump.fun/coin/${t.mint}`, target: '_blank', rel: 'noopener' }, 'pump.fun'))),
    el('span', { class: 'badge' }, t.program.startsWith('TokenzQd') ? 'Token-2022' : 'SPL'));
}

function scanResults() {
  if (state.loading) return el('div', { class: 'stack' }, [0, 1, 2].map(() => el('div', { class: 'skeleton', style: 'height:56px' })));
  if (!state.scanned) {
    return el('div', { class: 'empty' },
      el('h3', {}, 'Nothing scanned yet'),
      el('p', {}, 'Pick the compromised wallet and scan it to see what can still be saved.'));
  }
  const sol = Math.max(0, (state.balance ?? 0) + (state.vault ?? 0) - RENT_EXEMPT_MIN_LAMPORTS);
  const nothing = sol <= 0 && !state.tokens.length;
  return el('div', { class: 'stack', style: 'gap:16px' },
    state.error ? el('div', { class: 'callout danger' }, state.error) : null,
    el('div', { class: 'grid grid-2' },
      el('div', { class: 'card' }, el('div', { class: 'stat' },
        el('span', { class: 'stat-label' }, 'SOL balance'),
        el('span', { class: 'stat-value' }, state.balance == null ? '—' : fmt.sol(state.balance)))),
      el('div', { class: 'card' }, el('div', { class: 'stat' },
        el('span', { class: 'stat-label' }, 'Unclaimed creator fees'),
        el('span', { class: `stat-value ${state.vault ? 'green' : ''}` }, state.vault == null ? '—' : fmt.sol(state.vault))))),
    el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Tokens', state.tokens.length ? el('span', { class: 'badge' }, String(state.tokens.length)) : null),
      state.tokens.length
        ? el('div', { class: 'stack', style: 'gap:8px' }, state.tokens.map(tokenRow))
        : el('div', { class: 'dim' }, 'No token balances in this wallet.')),
    nothing
      ? el('div', { class: 'callout info' }, 'This wallet holds nothing worth rescuing. Anything sent to it later is still at risk while the key is exposed.')
      : el('div', { class: 'callout warn' }, `Ready to move ${sol > 0 ? fmt.sol(sol) : 'no SOL'}${state.tokens.length ? ` and ${selectedTokens().length} token type(s)` : ''} out in a single bundle.`));
}

function render() {
  const wallets = store.listWallets();
  const canRescue = state.scanned && state.victim && state.funder && state.funder !== state.victim && isPublicKey(state.destination)
    && (((state.balance ?? 0) + (state.vault ?? 0) > RENT_EXEMPT_MIN_LAMPORTS) || selectedTokens().length > 0);

  const victimSel = walletSelect({ selected: state.victim, allowNone: true, id: 'victim' });
  victimSel.addEventListener('change', () => { state.victim = victimSel.value || null; state.scanned = false; scan(); });

  // A rescue needs a wallet other than the exposed one to pay the fee and tip:
  // funding the exposed wallet instead just hands the sweeper bot the gas.
  const funders = wallets.filter((w) => !w.compromised && w.pubkey !== state.victim);
  if (state.funder && !funders.some((w) => w.pubkey === state.funder)) state.funder = null;
  if (!state.funder && funders.length === 1) state.funder = funders[0].pubkey;

  const funderSel = walletSelect({
    filter: (w) => funders.some((f) => f.pubkey === w.pubkey),
    selected: state.funder, allowNone: true, id: 'funder',
    emptyLabel: wallets.length ? 'No other wallet to pay with' : 'No wallets in vault yet',
  });
  funderSel.addEventListener('change', () => { state.funder = funderSel.value || null; render(); });

  const destinationChoices = state.victim ? funders : [];

  mount(page,
    el('h1', { class: 'page-title' }, 'Rescue a drained wallet'),
    el('p', { class: 'page-subtitle' }, 'If a private key leaked, a sweeper bot is probably watching that address and will take any SOL the moment it lands. This moves the balance, the tokens, and the unclaimed creator fees out in one Jito bundle, with a clean wallet paying the fee, so the bot never gets a slot to race.'),
    el('div', { class: 'grid grid-side' },
      el('div', { class: 'stack' },
        el('section', { class: 'card danger' },
          el('div', { class: 'card-title' }, 'The compromised wallet'),
          el('div', { class: 'form-group' },
            el('label', { class: 'form-label', for: 'victim' }, 'Wallet to empty'),
            victimSel,
            el('div', { class: 'form-hint' }, 'Import its private key on the Wallet page first; it has to sign.')),
          el('button', { class: 'btn btn-outline btn-sm', disabled: !state.victim || state.loading, onClick: scan },
            state.loading ? [el('span', { class: 'spinner' }), 'Scanning'] : 'Scan wallet')),
        scanResults()),
      el('aside', { class: 'card accent', style: 'position:sticky;top:calc(var(--header-h) + 20px)' },
        el('div', { class: 'card-title' }, 'Where it goes'),
        el('div', { class: 'form-group' },
          el('label', { class: 'form-label', for: 'funder' }, 'Clean wallet (pays fee + tip)'),
          funderSel,
          funders.length
            ? el('div', { class: 'form-hint' }, `Needs about ${fmt.sol(tipLamports() + 200_000)} to cover the tip and fees.`)
            : el('div', { class: 'callout warn', style: 'margin-top:8px' },
                'A rescue needs a second wallet to pay the fee. Funding the exposed wallet instead just hands the sweeper bot the gas. ',
                el('a', { href: '/', class: 'green' }, 'Generate a clean wallet'),
                ' and send it about ', fmt.sol(tipLamports() + 200_000), '.')),
        el('div', { class: 'form-group' },
          el('label', { class: 'form-label', for: 'dest' }, 'Safe destination'),
          el('input', { class: 'form-input mono', id: 'dest', placeholder: 'Address you control', value: state.destination,
            onInput: (e) => { state.destination = e.target.value.trim(); const btn = document.getElementById('rescue-btn'); if (btn) btn.disabled = !isPublicKey(state.destination) || !state.scanned; } }),
          el('div', { class: 'form-hint' }, 'A fresh wallet whose key has never been shared.'),
          destinationChoices.length
            ? el('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
                el('span', { class: 'form-hint' }, 'Use:'),
                destinationChoices.slice(0, 3).map((w) =>
                  el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { state.destination = w.pubkey; render(); } }, w.label)))
            : null),
        el('button', { id: 'rescue-btn', class: 'btn btn-primary btn-lg', disabled: !canRescue, onClick: rescue }, 'Rescue everything'),
        el('div', { class: 'form-hint', style: 'margin-top:10px' }, 'One bundle. Nothing partially lands.')),
    ),
  );
}

const initial = new URLSearchParams(location.search).get('wallet');
if (initial && store.listWallets().some((w) => w.pubkey === initial)) {
  state.victim = initial;
  scan();
} else {
  const compromised = store.listWallets().find((w) => w.compromised);
  if (compromised) { state.victim = compromised.pubkey; scan(); } else render();
}
