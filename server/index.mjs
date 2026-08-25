/**
 * pumpvault server: static files + the three proxies the browser cannot
 * call directly. It never sees a private key; every transaction arrives
 * at Jito already signed, straight from the browser.
 *
 *   POST /api/ipfs         -> https://pump.fun/api/ipfs      (no CORS upstream)
 *   GET  /api/pump/*       -> https://frontend-api-v3.pump.fun (blocks browser origins)
 *   POST /api/rpc          -> RPC_URL                          (keeps a paid RPC key server-side)
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUMP_API = 'https://frontend-api-v3.pump.fun';
const PUMP_IPFS = 'https://pump.fun/api/ipfs';
const DIST = join(__dirname, '..', 'dist');

const app = express();
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rpc: new URL(RPC_URL).host, cluster: RPC_URL.includes('devnet') ? 'devnet' : 'mainnet' });
});

app.post('/api/rpc', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(upstream.status).type('application/json').send(await upstream.text());
  } catch (e) {
    res.status(502).json({ error: `RPC upstream failed: ${e.message}` });
  }
});

app.get('/api/pump/{*path}', async (req, res) => {
  const path = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  try {
    const upstream = await fetch(`${PUMP_API}/${path}${qs}`, { headers: { accept: 'application/json' } });
    res.status(upstream.status).type('application/json').send(await upstream.text());
  } catch (e) {
    res.status(502).json({ error: `pump.fun API failed: ${e.message}` });
  }
});

app.post('/api/ipfs', express.raw({ type: 'multipart/form-data', limit: '12mb' }), async (req, res) => {
  const contentType = req.headers['content-type'];
  if (!contentType?.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'Expected multipart/form-data' });
  }
  try {
    const upstream = await fetch(PUMP_IPFS, { method: 'POST', headers: { 'content-type': contentType }, body: req.body });
    res.status(upstream.status).type('application/json').send(await upstream.text());
  } catch (e) {
    res.status(502).json({ error: `IPFS upload failed: ${e.message}` });
  }
});

if (existsSync(DIST)) {
  app.use(express.static(DIST, { extensions: ['html'], maxAge: '1h' }));
  app.use((_req, res) => res.status(404).sendFile(join(DIST, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`pumpvault listening on http://localhost:${PORT}  rpc=${new URL(RPC_URL).host}  static=${existsSync(DIST) ? 'dist/' : 'off (run vite dev)'}`);
});
