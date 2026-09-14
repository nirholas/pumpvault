/** Launch page: coin details, image upload, cost preview, atomic Jito launch. */
import { Keypair, PublicKey } from '@solana/web3.js';
import * as store from './store.js';
import { getConnection, getBalanceLamports, IPFS_PROXY } from './rpc.js';
import {
  buildCreateInstructions, estimateLaunchCost, fetchPumpLookupTables, uploadMetadata, validateCoinDetails,
} from '../lib/pump.js';
import { executePlan, planLaunch, resolveTipAccount } from '../lib/atomic.js';
import { CREATE_RENT_LAMPORTS } from '../lib/constants.js';
import { solToLamports } from '../lib/tx.js';
import {
  confirmModal, el, ensureUnlocked, explorerLinks, fmt, initShell, mount, progressModal, toast, walletSelect,
} from './app.js';

initShell('/launch');
const page = document.getElementById('page');

const state = {
  image: null,
  imageUrl: null,
  advanced: false,
  busy: false,
  balance: null,
};

const form = {
  name: '', symbol: '', description: '',
  twitter: '', telegram: '', website: '',
  devBuySol: '0', mayhemMode: false, cashback: false, holderReward: false,
  separateCreator: false, creatorPubkey: '',
};

function tipLamports() {
  return solToLamports(store.getSettings().launchTipSol);
}

function costRows() {
  const devBuy = Number(form.devBuySol) > 0 ? solToLamports(form.devBuySol) : 0;
  return estimateLaunchCost({ devBuyLamports: devBuy, tipLamports: tipLamports(), rentLamports: CREATE_RENT_LAMPORTS });
}

function setField(key, value) {
  form[key] = value;
	if (value && key === 'holderReward') {
		form.cashback = false;
		form.mayhemMode = false;
	}
	if (value && (key === 'cashback' || key === 'mayhemMode')) form.holderReward = false;
  renderSummary();
}

function field({ label, key, placeholder, maxlength, hint, type = 'text', textarea = false }) {
  const input = textarea
    ? el('textarea', { class: 'form-input', placeholder, maxlength, rows: 3, onInput: (e) => setField(key, e.target.value) }, form[key])
    : el('input', { class: 'form-input', type, placeholder, maxlength, value: form[key], onInput: (e) => setField(key, e.target.value) });
  const err = el('div', { class: 'form-error', style: 'display:none' });
  input.addEventListener('blur', () => {
    const errors = validateCoinDetails(form);
    err.textContent = errors[key] || '';
    err.style.display = errors[key] ? 'block' : 'none';
    input.classList.toggle('invalid', Boolean(errors[key]));
  });
  return el('div', { class: 'form-group' },
    el('label', { class: 'form-label' }, label),
    input,
    hint ? el('div', { class: 'form-hint' }, hint) : null,
    err);
}

function imagePicker() {
  const preview = el('div', { class: 'upload', tabindex: '0', role: 'button', 'aria-label': 'Upload coin image' });
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: 'display:none', onChange: (e) => pick(e.target.files[0]) });

  function paint() {
    mount(preview,
      state.imageUrl ? el('img', { src: state.imageUrl, alt: 'Coin image preview' }) : el('div', { style: 'font-size:28px' }, '🖼'),
      el('span', {}, state.image ? state.image.name : 'Click or drop an image'),
      el('span', { class: 'form-hint' }, 'PNG, JPG, GIF or WebP, up to 5 MB'));
  }

  function pick(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('Image must be 5 MB or smaller', 'err');
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.image = file;
    state.imageUrl = URL.createObjectURL(file);
    paint();
    renderSummary();
  }

  preview.addEventListener('click', () => input.click());
  preview.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  preview.addEventListener('dragover', (e) => { e.preventDefault(); preview.classList.add('drag'); });
  preview.addEventListener('dragleave', () => preview.classList.remove('drag'));
  preview.addEventListener('drop', (e) => { e.preventDefault(); preview.classList.remove('drag'); pick(e.dataTransfer.files[0]); });
  paint();
  return el('div', { class: 'form-group' }, el('label', { class: 'form-label' }, 'Coin image'), preview, input);
}

function toggle({ label, desc, key }) {
  const input = el('input', { type: 'checkbox', checked: form[key], onChange: (e) => setField(key, e.target.checked) });
  return el('label', { class: 'switch-row' },
    el('div', {}, el('div', { class: 'switch-label' }, label), el('div', { class: 'switch-desc' }, desc)),
    el('span', { class: 'switch' }, input, el('span', { class: 'track' })));
}

let summaryHost;
let payerSelect;

function renderSummary() {
  if (!summaryHost) return;
  const cost = costRows();
  const enough = state.balance == null || state.balance >= cost.totalLamports;
  mount(summaryHost,
    el('div', { class: 'card-title' }, 'What this costs'),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Mint + curve rent'), el('dd', {}, fmt.sol(cost.rentLamports)),
      el('dt', {}, 'Your first buy'), el('dd', {}, fmt.sol(cost.devBuyLamports)),
      el('dt', {}, 'Jito tip'), el('dd', {}, fmt.sol(cost.tipLamports)),
      el('dt', {}, 'Network fees'), el('dd', {}, fmt.sol(cost.feeBudgetLamports)),
      el('dt', {}, 'Total'), el('dd', { class: 'total' }, fmt.sol(cost.totalLamports))),
    el('div', { class: 'row spread', style: 'margin-top:14px' },
      el('span', { class: 'muted', style: 'font-size:13px' }, 'Payer balance'),
      el('span', { class: `mono ${enough ? 'green' : 'red'}` }, state.balance == null ? 'checking…' : fmt.sol(state.balance))),
    !enough ? el('div', { class: 'callout warn', style: 'margin-top:10px' }, `Send at least ${fmt.sol(cost.totalLamports - state.balance)} more to the payer wallet, then refresh.`) : null,
    el('div', { class: 'callout info', style: 'margin-top:14px' },
      'The create transaction and the Jito tip land in one bundle. If any part fails, the whole bundle is dropped and nothing is spent beyond network fees.'),
  );
}

async function refreshBalance() {
  const pubkey = payerSelect?.value;
  state.balance = null;
  renderSummary();
  if (!pubkey) return;
  try {
    state.balance = await getBalanceLamports(new PublicKey(pubkey));
  } catch (e) {
    toast(`Could not read balance: ${e.message}`, 'err');
  }
  renderSummary();
}

async function submit(e) {
  e.preventDefault();
  if (state.busy) return;

  const errors = validateCoinDetails(form);
  if (Object.keys(errors).length) return toast(Object.values(errors)[0], 'err');
  if (!state.image) return toast('Add a coin image', 'err');
  if (!(await ensureUnlocked())) return;

  const payerPubkey = payerSelect.value;
  if (!payerPubkey) return toast('Select a payer wallet', 'err');

  let creatorKeypair = null;
  if (form.separateCreator) {
    if (!form.creatorPubkey) return toast('Select a creator wallet', 'err');
    creatorKeypair = store.getKeypair(form.creatorPubkey);
  }

  const cost = costRows();
  const ok = await confirmModal({
    title: 'Launch this coin?',
    intro: 'This spends real SOL on Solana mainnet and cannot be undone.',
    rows: [
      ['Coin', `${form.name} (${form.symbol.toUpperCase()})`],
      ['Payer', payerPubkey],
      ['Creator (earns fees)', creatorKeypair ? creatorKeypair.publicKey.toBase58() : payerPubkey],
      ['First buy', fmt.sol(cost.devBuyLamports)],
      ['Jito tip', fmt.sol(cost.tipLamports)],
      ['Total leaving the payer', fmt.sol(cost.totalLamports), 'total'],
    ],
    confirmLabel: 'Launch on mainnet',
    note: 'Coin details are permanent once the mint exists.',
  });
  if (!ok) return;

  state.busy = true;
  const progress = progressModal('Launching your coin', [
    { key: 'metadata', label: 'Uploading image and metadata to IPFS' },
    { key: 'build', label: 'Building the create transaction' },
    { key: 'simulate', label: 'Simulating against mainnet' },
    { key: 'submit', label: 'Submitting the Jito bundle' },
    { key: 'confirm', label: 'Waiting for confirmation' },
  ]);

  try {
    progress.stage('metadata');
    const { metadataUri } = await uploadMetadata({
      image: state.image,
      name: form.name.trim(),
      symbol: form.symbol.trim().toUpperCase(),
      description: form.description,
      twitter: form.twitter,
      telegram: form.telegram,
      website: form.website,
    }, { endpoint: IPFS_PROXY });

    progress.stage('build', 'Fetching pump.fun program state');
    const connection = getConnection();
    const funder = store.getKeypair(payerPubkey);
    const creator = creatorKeypair ?? funder;
    const mint = Keypair.generate();
    const devBuyLamports = Number(form.devBuySol) > 0 ? solToLamports(form.devBuySol) : 0;

    const [{ instructions }, lookupTables, tipAccount] = await Promise.all([
      buildCreateInstructions({
        connection, mint: mint.publicKey,
        name: form.name.trim(), symbol: form.symbol.trim().toUpperCase(), uri: metadataUri,
        creator: creator.publicKey, user: creator.publicKey,
        devBuyLamports, mayhemMode: form.mayhemMode, cashback: form.cashback, holderReward: form.holderReward,
      }),
      fetchPumpLookupTables(connection, { cluster: store.getSettings().cluster }),
      resolveTipAccount(),
    ]);

    const plan = planLaunch({
      funder, creator, mint, createInstructions: instructions, lookupTables,
      devBuyLamports, rentLamports: CREATE_RENT_LAMPORTS,
      tipLamports: tipLamports(), tipAccount,
      priorityMicroLamports: store.getSettings().priorityMicroLamports,
    });

    const { bundleId, signatures } = await executePlan(connection, plan, {
      onStage: (stage, data) => {
        if (stage === 'simulate') progress.stage('simulate');
        if (stage === 'submit') progress.stage('submit');
        if (stage === 'confirm') progress.stage('confirm', `Bundle ${data.bundleId.slice(0, 12)}… submitted`);
      },
    });

    const mintAddress = mint.publicKey.toBase58();
    store.recordLaunch({
      mint: mintAddress, name: form.name.trim(), symbol: form.symbol.trim().toUpperCase(),
      creator: creator.publicKey.toBase58(), signature: signatures[signatures.length - 1], bundleId,
    });

    progress.done(el('div', { class: 'stack', style: 'gap:12px' },
      el('div', { class: 'callout ok' }, `${form.name} is live. Creator fees accrue to ${creator.publicKey.toBase58()}.`),
      el('div', { class: 'addr-row' }, el('code', {}, mintAddress)),
      explorerLinks({ mint: mintAddress, signatures, bundleId }),
      el('a', { class: 'btn btn-outline btn-sm', href: '/claim' }, 'Claim fees later →')));
    toast('Coin launched');
    refreshBalance();
  } catch (e) {
    progress.fail(e.message);
  } finally {
    state.busy = false;
  }
}

function render() {
  const wallets = store.listWallets();
  payerSelect = walletSelect({ filter: (w) => !w.compromised, id: 'payer' });
  payerSelect.addEventListener('change', refreshBalance);

  const creatorRow = el('div', { class: 'form-group', style: 'display:none' },
    el('label', { class: 'form-label' }, 'Creator wallet (receives the fees)'), el('div', { id: 'creator-select-host' }));

  const advancedHost = el('div', { style: 'display:none' },
    el('div', { class: 'form-row' },
      field({ label: 'X / Twitter', key: 'twitter', placeholder: 'https://x.com/…', type: 'url' }),
      field({ label: 'Telegram', key: 'telegram', placeholder: 'https://t.me/…', type: 'url' })),
    field({ label: 'Website', key: 'website', placeholder: 'https://…', type: 'url' }),
    toggle({ label: 'Mayhem mode', desc: 'pump.fun\'s higher-volatility curve', key: 'mayhemMode' }),
    toggle({ label: 'Holder rewards', desc: 'Route protocol creator fees to coin holders', key: 'holderReward' }),
    toggle({ label: 'Cashback', desc: 'Legacy fee routing for existing integrations', key: 'cashback' }),
    toggle({ label: 'Separate creator wallet', desc: 'Pay from one wallet, earn fees in another', key: 'separateCreator' }),
    creatorRow);

  summaryHost = el('aside', { class: 'card accent', style: 'position:sticky;top:calc(var(--header-h) + 20px)' });

  mount(page,
    el('h1', { class: 'page-title' }, 'Launch a coin'),
    el('p', { class: 'page-subtitle' }, 'Fill in the details, pick the wallet that pays, and send it as one atomic Jito bundle. The wallet you name as creator earns every creator fee the coin ever generates.'),
    !wallets.length
      ? el('div', { class: 'empty' },
          el('h3', {}, 'You need a wallet first'),
          el('p', {}, 'Generate one and fund it with about 0.05 SOL, then come back.'),
          el('a', { class: 'btn btn-primary', style: 'margin-top:14px', href: '/' }, 'Go to wallets'))
      : el('div', { class: 'grid grid-side' },
          el('form', { class: 'card', onSubmit: submit },
            imagePicker(),
            el('div', { class: 'form-row' },
              field({ label: 'Name', key: 'name', placeholder: 'Nyan Cat', maxlength: 32, hint: 'Up to 32 characters' }),
              field({ label: 'Ticker', key: 'symbol', placeholder: 'NYAN', maxlength: 10, hint: 'Up to 10 characters, no spaces' })),
            field({ label: 'Description', key: 'description', placeholder: 'What is this coin about?', textarea: true, maxlength: 1000 }),
            el('div', { class: 'form-group' },
              el('label', { class: 'form-label', for: 'payer' }, 'Pays for the launch'),
              payerSelect,
              el('div', { class: 'form-hint' }, 'This wallet covers rent, your first buy, and the Jito tip.')),
            el('div', { class: 'form-group' },
              el('label', { class: 'form-label' }, 'Your first buy (optional)'),
              el('div', { class: 'input-suffix' },
                el('input', { class: 'form-input', type: 'number', min: '0', step: '0.01', value: form.devBuySol, onInput: (e) => setField('devBuySol', e.target.value) }),
                el('span', {}, 'SOL')),
              el('div', { class: 'form-hint' }, 'Buys your own coin in the same transaction, before anyone else can.')),
            el('button', {
              type: 'button', class: 'btn btn-ghost btn-sm', style: 'margin-bottom:12px',
              onClick: (e) => { state.advanced = !state.advanced; advancedHost.style.display = state.advanced ? 'block' : 'none'; e.target.textContent = state.advanced ? 'Hide options' : 'More options'; },
            }, 'More options'),
            advancedHost,
            el('button', { type: 'submit', class: 'btn btn-primary btn-lg', style: 'margin-top:8px' }, 'Launch coin')),
          summaryHost),
  );

  if (wallets.length) {
    const host = creatorRow.querySelector('#creator-select-host');
    const sel = walletSelect({ selected: form.creatorPubkey });
    sel.addEventListener('change', () => setField('creatorPubkey', sel.value));
    form.creatorPubkey = form.creatorPubkey || sel.value;
    mount(host,sel);

    const sync = () => { creatorRow.style.display = form.separateCreator ? 'block' : 'none'; };
    advancedHost.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', sync));
    sync();

    const preselect = new URLSearchParams(location.search).get('wallet');
    if (preselect && [...payerSelect.options].some((o) => o.value === preselect)) payerSelect.value = preselect;
    renderSummary();
    refreshBalance();
  }
}

render();
