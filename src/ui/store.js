/**
 * Browser-side wallet store. Secret keys live only in localStorage, encrypted
 * with one passphrase (AES-256-GCM, see lib/vault.js). Decrypted keypairs are
 * cached in memory for the session and dropped on lock() or page unload.
 */
import { Keypair } from '@solana/web3.js';
import { decryptSecret, encryptSecret } from '../lib/vault.js';
import { parseSecretKey } from '../lib/keys.js';

const WALLETS_KEY = 'pumpvault.wallets.v1';
const CHECK_KEY = 'pumpvault.check.v1';
const SETTINGS_KEY = 'pumpvault.settings.v1';
const LAUNCHES_KEY = 'pumpvault.launches.v1';
const ACTIVE_KEY = 'pumpvault.active.v1';
const CHECK_PLAINTEXT = new TextEncoder().encode('pumpvault-passphrase-check');

/**
 * Auto-lock. The passphrase is cached in sessionStorage so moving between pages
 * does not re-prompt on every navigation; sessionStorage is scoped to this tab
 * and dropped when it closes. The cache expires after IDLE_LOCK_MS of no
 * activity, and Lock clears it immediately. Encrypted keys always stay at rest
 * in localStorage; only this short-lived passphrase copy makes navigation usable.
 */
const SESSION_KEY = 'pumpvault.session.v1';
export const IDLE_LOCK_MS = 15 * 60 * 1000;

const listeners = new Set();
const unlocked = new Map(); // pubkey -> Keypair
let sessionPassphrase = null;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  emit();
}
function emit() {
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const DEFAULT_SETTINGS = {
  rpcUrl: '',
  cluster: 'mainnet',
  launchTipSol: 0.001,
  rescueTipSol: 0.005,
  priorityMicroLamports: 500_000,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
}
export function saveSettings(patch) {
  write(SETTINGS_KEY, { ...getSettings(), ...patch });
}

export function listWallets() {
  return read(WALLETS_KEY, []);
}
export function getWallet(pubkey) {
  return listWallets().find((w) => w.pubkey === pubkey) || null;
}
export function getActivePubkey() {
  const stored = localStorage.getItem(ACTIVE_KEY);
  const wallets = listWallets();
  if (stored && wallets.some((w) => w.pubkey === stored)) return stored;
  return wallets[0]?.pubkey ?? null;
}
export function setActive(pubkey) {
  localStorage.setItem(ACTIVE_KEY, pubkey);
  emit();
}

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { pass, at } = JSON.parse(raw);
    if (Date.now() - at > IDLE_LOCK_MS) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return pass;
  } catch {
    return null;
  }
}

function touchSession(pass) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ pass, at: Date.now() }));
  } catch {
    /* private mode with no sessionStorage: the vault still works, it just re-prompts per page */
  }
}

/** Restore this tab's unlocked state after a navigation. Safe to call on every page. */
export async function restoreSession() {
  if (sessionPassphrase) return true;
  const pass = readSession();
  if (!pass) return false;
  try {
    await unlock(pass);
    return true;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return false;
  }
}

export function hasPassphrase() {
  return Boolean(localStorage.getItem(CHECK_KEY));
}
export function isUnlocked() {
  return sessionPassphrase !== null;
}

/** First-time setup or verification. Resolves the passphrase into the session cache. */
export async function unlock(passphrase) {
  const check = read(CHECK_KEY, null);
  if (!check) {
    localStorage.setItem(CHECK_KEY, JSON.stringify(await encryptSecret(CHECK_PLAINTEXT, passphrase)));
  } else {
    await decryptSecret(check, passphrase); // throws "Wrong passphrase"
  }
  sessionPassphrase = passphrase;
  touchSession(passphrase);
  unlocked.clear();
  for (const w of listWallets()) {
    unlocked.set(w.pubkey, Keypair.fromSecretKey(await decryptSecret(w.vault, passphrase)));
  }
  emit();
}

export function lock() {
  sessionPassphrase = null;
  unlocked.clear();
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* nothing cached */ }
  emit();
}

/** Refresh the idle timer. Called on real user interaction, not on background polling. */
export function touch() {
  if (sessionPassphrase) touchSession(sessionPassphrase);
}

export function getKeypair(pubkey) {
  const kp = unlocked.get(pubkey);
  if (!kp) throw new Error('Vault is locked');
  return kp;
}

async function persistWallet(keypair, { label, role, compromised = false }) {
  if (!sessionPassphrase) throw new Error('Unlock the vault first');
  const pubkey = keypair.publicKey.toBase58();
  const wallets = listWallets();
  if (wallets.some((w) => w.pubkey === pubkey)) throw new Error('That wallet is already in your vault');
  const vault = await encryptSecret(keypair.secretKey, sessionPassphrase);
  wallets.push({ pubkey, label: label || `${role} wallet ${wallets.length + 1}`, role, compromised, vault, createdAt: Date.now() });
  unlocked.set(pubkey, keypair);
  write(WALLETS_KEY, wallets);
  if (!localStorage.getItem(ACTIVE_KEY)) setActive(pubkey);
  return pubkey;
}

export async function createWallet({ label } = {}) {
  return persistWallet(Keypair.generate(), { label, role: 'generated' });
}

export async function importWallet(secret, { label, compromised = false } = {}) {
  return persistWallet(parseSecretKey(secret), { label, role: 'imported', compromised });
}

export function updateWallet(pubkey, patch) {
  const wallets = listWallets().map((w) => (w.pubkey === pubkey ? { ...w, ...patch } : w));
  write(WALLETS_KEY, wallets);
}

export function removeWallet(pubkey) {
  write(WALLETS_KEY, listWallets().filter((w) => w.pubkey !== pubkey));
  unlocked.delete(pubkey);
  if (localStorage.getItem(ACTIVE_KEY) === pubkey) localStorage.removeItem(ACTIVE_KEY);
  emit();
}

export function listLaunches() {
  return read(LAUNCHES_KEY, []);
}
export function recordLaunch(entry) {
  write(LAUNCHES_KEY, [{ ...entry, at: Date.now() }, ...listLaunches()].slice(0, 200));
}

window.addEventListener('pagehide', () => unlocked.clear());
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, () => touch(), { passive: true });
}
setInterval(() => {
  if (sessionPassphrase && !readSession()) {
    lock();
  }
}, 30_000);
