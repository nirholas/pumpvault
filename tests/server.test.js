import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, createApp, isAllowedRpcCall, pumpApiPath } from '../server/index.mjs';

const RPC_URL = 'https://rpc.example.test/?api-key=SECRET-KEY';
const MINT = 'So11111111111111111111111111111111111111112';

/** Records every upstream request and answers from `respond`; nothing reaches the network. */
function fakeUpstream() {
  const calls = [];
  let respond = () => new Response('{"jsonrpc":"2.0","id":1,"result":42}', { status: 200 });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  return { calls, fetchImpl, setResponder: (fn) => { respond = fn; } };
}

let server;
let base;
const upstream = fakeUpstream();
const logs = [];

beforeAll(async () => {
  const app = createApp({
    rpcUrl: RPC_URL, distDir: '/nonexistent', fetchImpl: upstream.fetchImpl,
    timeoutMs: { rpc: 50, pump: 50, ipfs: 50 }, log: (line) => logs.push(line),
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const rpc = (body) => fetch(`${base}/api/rpc`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('RPC allowlist', () => {
  it('accepts the reads and the simulation the app makes', () => {
    for (const method of ['getBalance', 'getLatestBlockhash', 'getMultipleAccounts', 'simulateTransaction', 'getBlockHeight']) {
      expect(isAllowedRpcCall({ jsonrpc: '2.0', id: 1, method, params: [] })).toBe(true);
    }
  });

  it('refuses sending, airdrops and anything outside the list', () => {
    for (const method of ['sendTransaction', 'requestAirdrop', 'getBlock', 'getSignaturesForAddress', 'minimumLedgerSlot']) {
      expect(isAllowedRpcCall({ jsonrpc: '2.0', id: 1, method, params: [] })).toBe(false);
    }
  });

  it('allows getProgramAccounts only for filtered scans of the two pump programs', () => {
    const filters = [{ memcmp: { offset: 0, bytes: '4y6pru6YvC7' } }];
    const call = (program, config) => ({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [program, config] });
    expect(isAllowedRpcCall(call('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', { filters }))).toBe(true);
    expect(isAllowedRpcCall(call('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { filters }))).toBe(true);
    expect(isAllowedRpcCall(call('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { filters }))).toBe(false);
    expect(isAllowedRpcCall(call('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', {}))).toBe(false);
  });

  it('rejects malformed envelopes', () => {
    expect(isAllowedRpcCall(null)).toBe(false);
    expect(isAllowedRpcCall([])).toBe(false);
    expect(isAllowedRpcCall({ method: 'getBalance' })).toBe(false);
    expect(isAllowedRpcCall({ jsonrpc: '2.0', method: 'getBalance', params: 'x' })).toBe(false);
  });

  it('forwards an allowed call to the configured RPC only', async () => {
    const before = upstream.calls.length;
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [MINT] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: 42 });
    expect(upstream.calls[before].url).toBe(RPC_URL);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers a disallowed call with 403 and never contacts the upstream', async () => {
    const before = upstream.calls.length;
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['AAAA'] });
    expect(res.status).toBe(403);
    expect(upstream.calls.length).toBe(before);
  });

  it('refuses a batch if any call in it is disallowed, and caps batch size', async () => {
    const ok = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };
    expect((await rpc([ok, { ...ok, method: 'requestAirdrop' }])).status).toBe(403);
    expect((await rpc(Array.from({ length: 21 }, () => ok))).status).toBe(403);
    expect((await rpc([])).status).toBe(403);
  });

  it('rejects an oversized body before it is parsed', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: ['x'.repeat(70 * 1024)] });
    expect(res.status).toBe(413);
  });

  it('reports an upstream failure without echoing the RPC URL or its key', async () => {
    upstream.setResponder(() => { throw new TypeError(`fetch failed for ${RPC_URL}`); });
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain('SECRET-KEY');
    expect(text).not.toContain('rpc.example.test');
    expect(logs.join('\n')).not.toContain('SECRET-KEY');
    upstream.setResponder(() => new Response('{}', { status: 200 }));
  });

  it('times out a hung upstream with 504', async () => {
    upstream.setResponder((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] });
    expect(res.status).toBe(504);
    upstream.setResponder(() => new Response('{}', { status: 200 }));
  });
});

describe('pump.fun API allowlist', () => {
  it('maps the two coin lookups and nothing else', () => {
    expect(pumpApiPath(`coins/${MINT}`, {})).toBe(`/coins/${MINT}`);
    expect(pumpApiPath('coins', { creator: MINT, limit: '50', offset: '0' })).toBe(`/coins?creator=${MINT}&limit=50&offset=0`);
    expect(pumpApiPath('coins', { limit: '50' })).toBeNull();
    expect(pumpApiPath('coins', { creator: MINT, sort: 'x' })).toBeNull();
    expect(pumpApiPath('coins', { creator: 'not-an-address' })).toBeNull();
    expect(pumpApiPath(`coins/${MINT}/../../admin`, {})).toBeNull();
    expect(pumpApiPath('users/me', {})).toBeNull();
    expect(pumpApiPath(`coins/${MINT}`, { extra: '1' })).toBeNull();
  });

  it('proxies an allowed lookup to the fixed upstream host', async () => {
    const before = upstream.calls.length;
    const res = await fetch(`${base}/api/pump/coins/${MINT}`);
    expect(res.status).toBe(200);
    expect(upstream.calls[before].url).toBe(`https://frontend-api-v3.pump.fun/coins/${MINT}`);
  });

  it('answers any other path with 404 and never contacts the upstream', async () => {
    const before = upstream.calls.length;
    for (const path of ['/api/pump/users', '/api/pump/coins/x/y', '/api/pump//evil.example/coins']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect(upstream.calls.length).toBe(before);
  });
});

describe('IPFS proxy', () => {
  it('requires multipart/form-data', async () => {
    const res = await fetch(`${base}/api/ipfs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('forwards a multipart upload to pump.fun', async () => {
    const before = upstream.calls.length;
    const form = new FormData();
    form.append('name', 'Coin');
    const res = await fetch(`${base}/api/ipfs`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(upstream.calls[before].url).toBe('https://pump.fun/api/ipfs');
  });
});

describe('security headers', () => {
  it('sends a CSP that only runs scripts from this origin, plus the hardening headers', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('reports the RPC host in health, never the full URL with its key', async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    expect(body.rpc).toBe('rpc.example.test');
    expect(JSON.stringify(body)).not.toContain('SECRET-KEY');
  });

  it('refuses a non-http RPC URL at startup', () => {
    expect(() => createApp({ rpcUrl: 'file:///etc/passwd' })).toThrow(/http/);
  });
});
