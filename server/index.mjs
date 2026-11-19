/**
 * pumpvault server: static files + the three proxies the browser cannot
 * call directly. It never sees a private key; every transaction arrives
 * at Jito already signed, straight from the browser.
 *
 *   POST /api/ipfs         -> https://pump.fun/api/ipfs      (no CORS upstream)
 *   GET  /api/pump/coins…  -> https://frontend-api-v3.pump.fun (blocks browser origins)
 *   POST /api/rpc          -> RPC_URL                          (keeps a paid RPC key server-side)
 *
 * Each proxy is an allowlist, not a relay: the RPC proxy forwards only the
 * read and simulate methods the app uses, the pump.fun proxy only the two
 * coin lookups, and nothing a client sends can change an upstream host.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUMP_API = 'https://frontend-api-v3.pump.fun';
const PUMP_IPFS = 'https://pump.fun/api/ipfs';

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/**
 * JSON-RPC methods the browser build calls (web3.js `Connection` plus the pump SDKs).
 * Sending is not here: signed transactions go from the browser to Jito directly.
 */
export const RPC_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getHealth',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountsByOwner',
  'simulateTransaction',
]);
/** `getProgramAccounts` is the one expensive read; it is only needed for the creator scans. */
const SCANNABLE_PROGRAMS = new Set([PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]);
const MAX_RPC_BATCH = 20;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMP_COIN_QUERY = new Set(['creator', 'limit', 'offset']);

/**
 * Content-Security-Policy for the built pages. Scripts load only from this origin.
 * `connect-src` allows any HTTPS/WSS endpoint because the browser talks to Jito's block
 * engines directly and a user may point the app at their own RPC in settings.
 * Inline styles are allowed because the UI sets element `style` attributes.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(_req, res, next) {
  res.set({
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  });
  next();
}

/** True when a JSON-RPC call is one the app makes, with parameters inside the allowlist. */
export function isAllowedRpcCall(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return false;
  if (call.jsonrpc !== '2.0' || typeof call.method !== 'string') return false;
  if (!RPC_METHODS.has(call.method)) return false;
  if (call.params !== undefined && !Array.isArray(call.params)) return false;
  if (call.method === 'getProgramAccounts') {
    const [program, config] = call.params ?? [];
    if (!SCANNABLE_PROGRAMS.has(program)) return false;
    // Unfiltered scans of either program return gigabytes; the app always filters.
    if (!Array.isArray(config?.filters) || config.filters.length === 0) return false;
  }
  return true;
}

/**
 * Upstream path for a `/api/pump/*` request, or null when it is not one of the
 * lookups the app makes: `coins/<mint>` and `coins?creator=…&limit=…&offset=…`.
 */
export function pumpApiPath(path, query) {
  if (path === 'coins') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (!PUMP_COIN_QUERY.has(key) || typeof value !== 'string') return null;
      if (key === 'creator' ? !BASE58_ADDRESS.test(value) : !/^\d{1,4}$/.test(value)) return null;
      params.set(key, value);
    }
    if (!params.has('creator')) return null;
    return `/coins?${params}`;
  }
  const match = /^coins\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (match && Object.keys(query).length === 0) return `/coins/${match[1]}`;
  return null;
}

/** Relay an upstream response body as JSON, never caching it. */
async function relay(res, upstream) {
  res.status(upstream.status).type('application/json').set('cache-control', 'no-store').send(await upstream.text());
}

/** Upstream failures are logged here and reported generically, so an RPC URL (and its key) never reaches a client. */
function upstreamFailed(res, label, error, log) {
  const reason = error?.name === 'TimeoutError' ? 'timed out' : 'failed';
  log(`${label} upstream ${reason}: ${error?.cause?.code ?? error?.name ?? 'error'}`);
  res.status(error?.name === 'TimeoutError' ? 504 : 502).json({ error: `${label} upstream ${reason}` });
}

/**
 * Build the Express app. Exported so tests can run it against a fake upstream.
 * @param {{
 *   rpcUrl?: string,
 *   distDir?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: { rpc?: number, pump?: number, ipfs?: number },
 *   log?: (line: string) => void,
 * }} [options]
 */
export function createApp({
  rpcUrl = 'https://api.mainnet-beta.solana.com',
  distDir = join(__dirname, '..', 'dist'),
  fetchImpl = fetch,
  timeoutMs = {},
  log = (line) => console.error(line),
} = {}) {
  const rpc = new URL(rpcUrl);
  if (rpc.protocol !== 'https:' && rpc.protocol !== 'http:') throw new Error('RPC_URL must be an http(s) URL');
  const timeouts = { rpc: 20_000, pump: 10_000, ipfs: 30_000, ...timeoutMs };

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rpc: rpc.host, cluster: rpc.href.includes('devnet') ? 'devnet' : 'mainnet' });
  });

  app.post('/api/rpc', express.json({ limit: '64kb' }), async (req, res) => {
    const calls = Array.isArray(req.body) ? req.body : [req.body];
    if (calls.length === 0 || calls.length > MAX_RPC_BATCH || !calls.every(isAllowedRpcCall)) {
      return res.status(403).json({ error: 'RPC method not allowed through this proxy' });
    }
    try {
      const upstream = await fetchImpl(rpc.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeouts.rpc),
      });
      await relay(res, upstream);
    } catch (e) {
      upstreamFailed(res, 'RPC', e, log);
    }
  });

  app.get('/api/pump/{*path}', async (req, res) => {
    const path = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const upstreamPath = pumpApiPath(path, req.query);
    if (!upstreamPath) return res.status(404).json({ error: 'Not a pump.fun lookup this proxy serves' });
    try {
      const upstream = await fetchImpl(`${PUMP_API}${upstreamPath}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeouts.pump),
      });
      await relay(res, upstream);
    } catch (e) {
      upstreamFailed(res, 'pump.fun API', e, log);
    }
  });

  app.post('/api/ipfs', express.raw({ type: 'multipart/form-data', limit: '8mb' }), async (req, res) => {
    const contentType = req.headers['content-type'];
    if (!contentType?.startsWith('multipart/form-data') || !(req.body instanceof Uint8Array)) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }
    try {
      const upstream = await fetchImpl(PUMP_IPFS, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: req.body,
        signal: AbortSignal.timeout(timeouts.ipfs),
      });
      await relay(res, upstream);
    } catch (e) {
      upstreamFailed(res, 'IPFS', e, log);
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Body-parser errors (oversized or malformed bodies) carry a status; answer them without a stack trace.
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log(`unhandled error: ${err?.name ?? 'error'}`);
    const message = status === 413 ? 'Request body too large' : status === 500 ? 'Internal error' : 'Bad request';
    res.status(status).json({ error: message });
  });

  if (existsSync(distDir)) {
    app.use(express.static(distDir, { extensions: ['html'], maxAge: '1h' }));
    app.use((_req, res) => res.status(404).sendFile(join(distDir, 'index.html')));
  }
  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const distDir = join(__dirname, '..', 'dist');
  createApp({ rpcUrl, distDir }).listen(port, () => {
    console.log(`pumpvault listening on http://localhost:${port}  rpc=${new URL(rpcUrl).host}  static=${existsSync(distDir) ? 'dist/' : 'off (run vite dev)'}`);
  });
}
