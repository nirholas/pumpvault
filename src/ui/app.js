/** Shared shell: header, wallet chip, passphrase gate, modals, toasts, helpers. */
import * as store from './store.js';
import { getBalanceLamports } from './rpc.js';
import { PublicKey } from '@solana/web3.js';
import { lamportsToSol } from '../lib/tx.js';
import { shortAddress } from '../lib/keys.js';

export const fmt = {
  sol: (lamports, digits = 4) => `${lamportsToSol(lamports, digits)} SOL`,
  addr: (pk, n = 4) => shortAddress(pk, n),
  time: (ms) => new Date(ms).toLocaleString(),
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * Replace a host's children. Unlike replaceChildren, null and false are dropped
 * rather than stringified, so conditional sections can be inlined safely.
 */
export function mount(host, ...children) {
  host.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

export function toast(message, type = 'ok', ms = 5000) {
  let host = document.querySelector('.toasts');
  if (!host) document.body.append((host = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })));
  const t = el('div', { class: `toast ${type}` }, message);
  host.append(t);
  setTimeout(() => t.remove(), type === 'err' ? Math.max(ms, 9000) : ms);
}

export async function copy(text, label = 'Copied') {
  await navigator.clipboard.writeText(text);
  toast(label);
}

function openModal(content, { onClose } = {}) {
  const backdrop = el('div', { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' });
  const box = el('div', { class: 'modal' }, content);
  backdrop.append(box);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  requestAnimationFrame(() => box.querySelector('input, textarea, button')?.focus());
  return { close, box };
}

/** Resolve at most once: closing a modal must not overwrite the value its submit handler already produced. */
function once(resolve) {
  let settled = false;
  return (value) => { if (!settled) { settled = true; resolve(value); } };
}

/** Review-before-sign modal. Resolves true only on explicit confirmation. */
export function confirmModal({ title, intro, rows = [], confirmLabel = 'Confirm', danger = false, note }) {
  return new Promise((raw) => {
    const resolve = once(raw);
    const dl = el('dl', { class: 'kv' }, rows.map(([k, v, cls]) => [el('dt', {}, k), el('dd', { class: cls || '' }, v)]));
    const modal = openModal([
      el('h2', {}, title),
      intro ? el('p', { class: 'intro' }, intro) : null,
      dl,
      note ? el('div', { class: 'callout warn', style: 'margin-top:14px' }, note) : null,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn btn-ghost', onClick: () => { resolve(false); modal.close(); } }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => { resolve(true); modal.close(); } }, confirmLabel)),
    ], { onClose: () => resolve(false) });
  });
}

/** Generic form modal. `fields`: [{name,label,type,placeholder,hint,value}] → resolves values or null. */
export function formModal({ title, intro, fields, submitLabel = 'Save' }) {
  return new Promise((raw) => {
    const resolve = once(raw);
    const inputs = {};
    const form = el('form', { onSubmit: (e) => { e.preventDefault(); const out = {}; for (const [k, i] of Object.entries(inputs)) out[k] = i.type === 'checkbox' ? i.checked : i.value; resolve(out); modal.close(); } },
      el('h2', {}, title),
      intro ? el('p', { class: 'intro' }, intro) : null,
      fields.map((f) => {
        if (f.type === 'checkbox') {
          inputs[f.name] = el('input', { type: 'checkbox', checked: f.value || false });
          return el('label', { class: 'check', style: 'margin-bottom:14px' }, inputs[f.name], f.label);
        }
        inputs[f.name] = f.type === 'textarea'
          ? el('textarea', { class: 'form-input mono', placeholder: f.placeholder || '', required: f.required, rows: 3 }, f.value || '')
          : el('input', { class: `form-input ${f.mono ? 'mono' : ''}`, type: f.type || 'text', placeholder: f.placeholder || '', value: f.value || '', required: f.required, autocomplete: f.type === 'password' ? 'current-password' : 'off', minlength: f.minlength });
        return el('div', { class: 'form-group' }, el('label', { class: 'form-label' }, f.label), inputs[f.name], f.hint ? el('div', { class: 'form-hint' }, f.hint) : null);
      }),
      el('div', { class: 'modal-actions' },
        el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { resolve(null); modal.close(); } }, 'Cancel'),
        el('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel)),
    );
    const modal = openModal(form, { onClose: () => resolve(null) });
  });
}

export function infoModal({ title, body, actions = [] }) {
  const modal = openModal([
    el('h2', {}, title),
    el('div', { style: 'margin-top:10px' }, body),
    el('div', { class: 'modal-actions' },
      actions.map((a) => el('button', { class: `btn ${a.class || 'btn-outline'}`, onClick: () => a.onClick?.(modal) }, a.label)),
      el('button', { class: 'btn btn-primary', onClick: () => modal.close() }, 'Close')),
  ]);
  return modal;
}

/** Live progress modal for a bundle. */
export function progressModal(title, stages) {
  const items = stages.map((s) => el('div', { class: 'step' }, el('i', {}, ''), s.label));
  const detail = el('div', { class: 'muted', style: 'font-size:13px;margin-top:12px;min-height:20px' });
  const result = el('div', { style: 'margin-top:14px' });
  const actions = el('div', { class: 'modal-actions' });
  const modal = openModal([el('h2', {}, title), el('div', { class: 'steps', style: 'margin-top:14px' }, items), detail, result, actions]);
  let idx = -1;
  return {
    stage(key, text) {
      const i = stages.findIndex((s) => s.key === key);
      if (i < 0) return;
      for (let j = 0; j < items.length; j++) {
        items[j].className = j < i ? 'step done' : j === i ? 'step on' : 'step';
        items[j].querySelector('i').textContent = j < i ? '✓' : '';
      }
      idx = i;
      if (text) detail.textContent = text;
    },
    done(node) {
      items.forEach((it) => { it.className = 'step done'; it.querySelector('i').textContent = '✓'; });
      detail.textContent = '';
      result.replaceChildren(node);
      actions.replaceChildren(el('button', { class: 'btn btn-primary', onClick: () => modal.close() }, 'Done'));
    },
    fail(message) {
      if (idx >= 0) { items[idx].className = 'step fail'; items[idx].querySelector('i').textContent = '!'; }
      detail.textContent = '';
      result.replaceChildren(el('div', { class: 'callout danger', style: 'white-space:pre-wrap' }, message));
      actions.replaceChildren(el('button', { class: 'btn btn-outline', onClick: () => modal.close() }, 'Close'));
    },
  };
}

/** Passphrase gate. Creates the vault passphrase on first use. */
export async function ensureUnlocked() {
  if (store.isUnlocked()) return true;
  const first = !store.hasPassphrase();
  while (true) {
    const values = await formModal({
      title: first ? 'Create a vault passphrase' : 'Unlock your vault',
      intro: first
        ? 'Your keys are encrypted with this passphrase and stored only in this browser. There is no recovery: back up every wallet you create.'
        : 'Keys stay encrypted at rest; unlocking caches them in memory until you lock or close the tab.',
      fields: [{ name: 'pass', label: 'Passphrase', type: 'password', required: true, minlength: 8, hint: 'At least 8 characters' }],
      submitLabel: first ? 'Create vault' : 'Unlock',
    });
    if (!values) return false;
    try {
      await store.unlock(values.pass);
      return true;
    } catch (e) {
      toast(e.message, 'err');
    }
  }
}

/**
 * <select> of vault wallets. `filter(w)` narrows the list. Passing `selected:
 * null` means "nothing chosen yet" and leaves the placeholder showing, so the
 * control never displays a wallet the page does not consider selected; omitting
 * `selected` falls back to the active wallet.
 */
export function walletSelect({ filter = () => true, selected, allowNone = false, id, emptyLabel = 'No wallets in vault yet' } = {}) {
  const sel = el('select', { class: 'form-input mono', id });
  const wallets = store.listWallets().filter(filter);
  if (allowNone || !wallets.length) {
    sel.append(el('option', { value: '' }, wallets.length ? 'Select a wallet' : emptyLabel));
  }
  const target = selected === undefined ? store.getActivePubkey() : selected;
  for (const w of wallets) {
    sel.append(el('option', { value: w.pubkey, selected: w.pubkey === target },
      `${w.label} · ${shortAddress(w.pubkey, 6)}${w.compromised ? ' · compromised' : ''}`));
  }
  return sel;
}

/** Deterministic tint per mint, so a coin without a working image still looks intentional. */
function tintFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 60% 22%)`;
}

/**
 * Coin image with a real fallback. Remote art lives on IPFS gateways that go
 * down, rate limit, or get blocked, and a broken-image icon reads as a bug, so
 * a failed load swaps in an initials tile instead.
 */
export function coinAvatar({ image, symbol = '', mint = '', size = 48 }) {
  const initials = (symbol || mint).slice(0, 3).toUpperCase();
  const tile = () => el('div', {
    class: 'coin-ph',
    style: `width:${size}px;height:${size}px;background:${tintFor(mint || symbol || 'x')};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size / 3.6)}px;color:var(--text-secondary)`,
    'aria-hidden': 'true',
  }, initials);
  if (!image) return tile();
  const img = el('img', {
    src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
    style: `width:${size}px;height:${size}px`,
  });
  img.addEventListener('error', () => img.replaceWith(tile()), { once: true });
  return img;
}

export function explorerLinks({ signatures = [], bundleId, mint }) {
  return el('div', { class: 'row', style: 'gap:8px' },
    mint ? el('a', { class: 'btn btn-primary btn-sm', href: `https://pump.fun/coin/${mint}`, target: '_blank', rel: 'noopener' }, 'Open on pump.fun') : null,
    signatures.map((s, i) => el('a', { class: 'btn btn-outline btn-sm', href: `https://solscan.io/tx/${s}`, target: '_blank', rel: 'noopener' }, signatures.length > 1 ? `Tx ${i + 1} on Solscan` : 'View on Solscan')),
    bundleId ? el('a', { class: 'btn btn-ghost btn-sm', href: `https://explorer.jito.wtf/bundle/${bundleId}`, target: '_blank', rel: 'noopener' }, 'Jito bundle') : null,
  );
}

const NAV = [
  ['/', 'Wallet'],
  ['/launch', 'Launch'],
  ['/claim', 'Claim fees'],
  ['/rescue', 'Rescue'],
];

export function initShell(page) {
  const header = el('header', { class: 'header' },
    el('div', { class: 'header-inner' },
      el('a', { class: 'logo', href: '/' }, el('span', { class: 'logo-accent' }, '▲'), el('span', { class: 'word' }, 'pump', el('span', { class: 'logo-accent' }, 'vault'))),
      el('nav', { class: 'nav', 'aria-label': 'Primary' }, NAV.map(([href, label]) => el('a', { class: `nav-link ${href === page ? 'active' : ''}`, href: href, 'aria-current': href === page ? 'page' : null }, label))),
      el('div', { id: 'wallet-chip' }),
    ));
  document.body.prepend(header);
  document.body.append(el('footer', { class: 'footer' },
    'Non-custodial. Keys never leave this browser. ',
    el('a', { href: 'https://github.com/nirholas/pumpvault', target: '_blank', rel: 'noopener' }, 'Source'), ' · ',
    el('a', { href: 'https://github.com/nirholas/atomic', target: '_blank', rel: 'noopener' }, 'Atomic bundles')));
  renderChip();
  store.subscribe(renderChip);
  store.restoreSession().then((ok) => { if (ok) renderChip(); });
}

let chipTimer = null;
async function renderChip() {
  const host = document.getElementById('wallet-chip');
  if (!host) return;
  const active = store.getActivePubkey();
  const wallet = active ? store.getWallet(active) : null;
  const unlockedNow = store.isUnlocked();
  host.replaceChildren(el('div', { class: 'wallet-chip' },
    el('span', { class: `dot ${unlockedNow ? 'on' : ''}`, title: unlockedNow ? 'Vault unlocked' : 'Vault locked' }),
    wallet ? el('span', { class: 'addr mono', title: wallet.pubkey }, `${wallet.label} · ${shortAddress(wallet.pubkey)}`) : el('span', { class: 'muted' }, 'No wallet'),
    el('span', { id: 'chip-balance', class: 'mono muted' }, ''),
    unlockedNow
      ? el('button', { onClick: () => { store.lock(); toast('Vault locked'); } }, 'Lock')
      : el('button', { onClick: () => ensureUnlocked() }, store.hasPassphrase() ? 'Unlock' : 'Set up'),
  ));
  clearTimeout(chipTimer);
  if (wallet) {
    const refresh = async () => {
      try {
        const lamports = await getBalanceLamports(new PublicKey(wallet.pubkey));
        const node = document.getElementById('chip-balance');
        if (node) node.textContent = fmt.sol(lamports);
      } catch { /* balance is decorative here; the page surfaces RPC errors */ }
      chipTimer = setTimeout(refresh, 20_000);
    };
    refresh();
  }
}
