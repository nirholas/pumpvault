/** Wallet page: create or import wallets, fund by QR, see balances and launches. */
import QRCode from 'qrcode';
import { PublicKey } from '@solana/web3.js';
import * as store from './store.js';
import { getBalanceLamports, getConnection } from './rpc.js';
import { secretKeyToBase58, secretKeyToJson, shortAddress } from '../lib/keys.js';
import { getCreatorVaultLamports } from '../lib/fees.js';
import {
  coinAvatar, confirmModal, copy, el, mount, ensureUnlocked, fmt, formModal, infoModal, initShell, toast,
} from './app.js';

initShell('/');

const page = document.getElementById('page');

function hero() {
  return el('section', { class: 'hero fade-in' },
    el('h1', {}, 'Your wallet, ', el('span', { class: 'green' }, 'your keys')),
    el('p', {}, 'Generate a Solana wallet right here, send SOL to its QR code, and use it to launch coins on pump.fun or claim the creator fees your coins already earned. Keys are encrypted with your passphrase and never leave this browser.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-primary', onClick: onCreate }, 'Generate a wallet'),
      el('button', { class: 'btn btn-outline', onClick: onImport }, 'Import a private key'),
      el('a', { class: 'btn btn-ghost', href: '/launch' }, 'Launch a coin →')),
  );
}

async function onCreate() {
  if (!(await ensureUnlocked())) return;
  const values = await formModal({
    title: 'Generate a wallet',
    intro: 'A fresh keypair is created in this tab. Back up the private key before you send it any SOL.',
    fields: [{ name: 'label', label: 'Label', placeholder: 'Launch wallet', hint: 'Only you see this.' }],
    submitLabel: 'Generate',
  });
  if (!values) return;
  const pubkey = await store.createWallet({ label: values.label?.trim() });
  toast('Wallet created');
  showBackup(pubkey);
  render();
}

async function onImport() {
  if (!(await ensureUnlocked())) return;
  const values = await formModal({
    title: 'Import a private key',
    intro: 'Paste a base58 key (Phantom, Solflare, Backpack) or a JSON byte array from solana-keygen. It is encrypted with your passphrase before it touches localStorage.',
    fields: [
      { name: 'secret', label: 'Private key', type: 'textarea', required: true, placeholder: '5Kd... or [12,34,...]' },
      { name: 'label', label: 'Label', placeholder: 'Creator wallet' },
      { name: 'compromised', label: 'This key may be compromised (a sweeper bot could be watching it)', type: 'checkbox' },
    ],
    submitLabel: 'Import',
  });
  if (!values) return;
  try {
    const pubkey = await store.importWallet(values.secret, { label: values.label?.trim(), compromised: values.compromised });
    toast(`Imported ${shortAddress(pubkey)}`);
    if (values.compromised) toast('Marked as compromised. Use Rescue to move its funds out atomically.', 'ok', 8000);
    render();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function showBackup(pubkey) {
  const kp = store.getKeypair(pubkey);
  const b58 = secretKeyToBase58(kp);
  infoModal({
    title: 'Back up this private key',
    body: el('div', { class: 'stack', style: 'gap:12px' },
      el('div', { class: 'callout warn' }, 'Anyone with this key controls the wallet. Store it in a password manager. pumpvault cannot recover it for you.'),
      el('div', { class: 'form-label' }, 'Base58 (Phantom, Solflare, Backpack)'),
      el('div', { class: 'secret-box' }, b58),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-outline btn-sm', onClick: () => copy(b58, 'Private key copied') }, 'Copy base58'),
        el('button', { class: 'btn btn-ghost btn-sm', onClick: () => copy(secretKeyToJson(kp), 'JSON array copied') }, 'Copy JSON array'),
        el('button', { class: 'btn btn-ghost btn-sm', onClick: () => downloadKey(pubkey, secretKeyToJson(kp)) }, 'Download keypair.json')),
    ),
  });
}

function downloadKey(pubkey, json) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = el('a', { href: url, download: `${pubkey}.keypair.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function qrCanvas(address) {
  const canvas = el('canvas');
  await QRCode.toCanvas(canvas, `solana:${address}`, { width: 264, margin: 0, color: { dark: '#0e0e16', light: '#ffffff' } });
  return canvas;
}

function walletCard(w) {
  const active = w.pubkey === store.getActivePubkey();
  const balance = el('span', { class: 'stat-value' }, el('span', { class: 'skeleton', style: 'display:inline-block;width:90px;height:22px' }));
  const fees = el('span', { class: 'stat-value' }, el('span', { class: 'skeleton', style: 'display:inline-block;width:90px;height:22px' }));
  const qrHost = el('div', { class: 'qr' });

  qrCanvas(w.pubkey).then((c) => mount(qrHost,c)).catch(() => mount(qrHost,el('div', { class: 'dim', style: 'color:#333;font-size:12px;padding:8px' }, 'QR unavailable')));

  (async () => {
    const pk = new PublicKey(w.pubkey);
    const [bal, vault] = await Promise.allSettled([getBalanceLamports(pk), getCreatorVaultLamports(getConnection(), pk)]);
    balance.textContent = bal.status === 'fulfilled' ? fmt.sol(bal.value) : 'RPC error';
    if (bal.status === 'rejected') balance.className = 'stat-value red';
    fees.textContent = vault.status === 'fulfilled' ? fmt.sol(vault.value) : 'unavailable';
    if (vault.status === 'fulfilled' && vault.value > 0) fees.className = 'stat-value green';
  })();

  return el('article', { class: `card wallet-card ${active ? 'active' : ''} fade-in` },
    el('div', { class: 'row spread' },
      el('div', { class: 'row', style: 'gap:8px' },
        el('strong', {}, w.label),
        active ? el('span', { class: 'badge green' }, 'active') : null,
        w.compromised ? el('span', { class: 'badge red' }, 'compromised') : null,
        w.role === 'imported' ? el('span', { class: 'badge' }, 'imported') : null),
      el('button', { class: 'icon-btn', title: 'Rename', 'aria-label': `Rename ${w.label}`, onClick: () => onRename(w) }, '✎')),
    qrHost,
    el('div', { class: 'dim', style: 'text-align:center;font-size:12px' }, 'Send SOL to this address'),
    el('div', { class: 'addr-row' },
      el('code', {}, w.pubkey),
      el('button', { class: 'icon-btn', title: 'Copy address', 'aria-label': 'Copy address', onClick: () => copy(w.pubkey, 'Address copied') }, '⧉')),
    el('div', { class: 'row spread' },
      el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, 'Balance'), balance),
      el('div', { class: 'stat', style: 'text-align:right' }, el('span', { class: 'stat-label' }, 'Unclaimed fees'), fees)),
    el('div', { class: 'wallet-actions' },
      !active ? el('button', { class: 'btn btn-outline btn-sm', onClick: () => { store.setActive(w.pubkey); toast(`${w.label} is now active`); } }, 'Make active') : null,
      el('a', { class: 'btn btn-outline btn-sm', href: `${'/claim'}?wallet=${w.pubkey}` }, 'Claim fees'),
      el('a', { class: 'btn btn-ghost btn-sm', href: `${'/launch'}?wallet=${w.pubkey}` }, 'Launch'),
      el('button', { class: 'btn btn-ghost btn-sm', onClick: () => showBackup(w.pubkey) }, 'Export key'),
      el('a', { class: 'btn btn-ghost btn-sm', href: `https://solscan.io/account/${w.pubkey}`, target: '_blank', rel: 'noopener' }, 'Solscan'),
      el('button', { class: 'btn btn-danger btn-sm', onClick: () => onRemove(w) }, 'Remove')),
  );
}

async function onRename(w) {
  const values = await formModal({ title: 'Rename wallet', fields: [{ name: 'label', label: 'Label', value: w.label, required: true }], submitLabel: 'Save' });
  if (!values) return;
  store.updateWallet(w.pubkey, { label: values.label.trim() });
  render();
}

async function onRemove(w) {
  const ok = await confirmModal({
    title: 'Remove from vault?',
    intro: 'This deletes the encrypted key from this browser. Without your own backup the wallet is gone for good.',
    rows: [['Wallet', w.label], ['Address', w.pubkey]],
    confirmLabel: 'Remove',
    danger: true,
    note: 'Export the private key first if you still need it.',
  });
  if (!ok) return;
  store.removeWallet(w.pubkey);
  toast('Wallet removed');
  render();
}

function launchRow(r) {
  return el('div', { class: 'coin-row' },
    coinAvatar({ image: r.image, symbol: r.symbol, mint: r.mint }),
    el('div', {},
      el('div', { class: 'coin-name' }, r.name || 'Coin', el('span', { class: 'badge' }, r.symbol || '')),
      el('div', { class: 'coin-meta' },
        el('span', {}, fmt.time(r.at)),
        el('a', { href: `https://pump.fun/coin/${r.mint}`, target: '_blank', rel: 'noopener' }, 'pump.fun'),
        el('a', { href: `https://solscan.io/tx/${r.signature}`, target: '_blank', rel: 'noopener' }, 'transaction'))),
    el('div', { class: 'coin-side' }, el('span', { class: 'mono dim' }, shortAddress(r.mint, 5))));
}

function launchHistory() {
  const rows = store.listLaunches();
  if (!rows.length) return null;
  return el('section', { class: 'card', style: 'margin-top:20px' },
    el('div', { class: 'card-title' }, 'Coins you launched here'),
    el('div', { class: 'coin-list' }, rows.map(launchRow)));
}

function render() {
  const wallets = store.listWallets();
  mount(page,
    hero(),
    wallets.length
      ? el('section', { class: 'wallet-grid' }, wallets.map(walletCard))
      : el('section', { class: 'empty' },
          el('h3', {}, 'No wallets yet'),
          el('p', {}, 'Generate one to get a fundable address and QR code, or import a key you already own.'),
          el('div', { class: 'row', style: 'justify-content:center;margin-top:14px' },
            el('button', { class: 'btn btn-primary', onClick: onCreate }, 'Generate a wallet'),
            el('button', { class: 'btn btn-outline', onClick: onImport }, 'Import a key'))),
    wallets.length ? el('div', { class: 'callout info', style: 'margin-top:20px' },
      'Funding tip: a launch needs roughly 0.03 SOL for rent and fees, plus whatever you want as your first buy. Send 0.05 SOL to cover a launch comfortably.') : null,
    launchHistory(),
  );
}

render();
store.subscribe(render);
