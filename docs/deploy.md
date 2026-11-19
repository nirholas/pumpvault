# Deploying

pumpvault is a static site plus a small proxy. Anywhere that runs Node 20 works.

## Any Node host

```bash
npm ci
npm run build          # writes dist/
RPC_URL=https://your-endpoint PORT=8787 npm start
```

`server/index.mjs` then serves `dist/` and the three proxy routes on one port. Put a TLS terminator in front of it.

## Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "start"]
```

## Static host plus your own proxy

The frontend is plain static files, so any CDN can serve `dist/`. Three requests still need a same-origin proxy, because browsers cannot make them directly:

| Path | Upstream | Reason |
| --- | --- | --- |
| `POST /api/rpc` | your RPC endpoint | keeps a paid key off the client |
| `GET /api/pump/*` | `https://frontend-api-v3.pump.fun` | upstream returns 403 to browser origins |
| `POST /api/ipfs` | `https://pump.fun/api/ipfs` | upstream sends no CORS headers |

Anything that can proxy an HTTP request works: a Cloudflare Worker, an nginx `proxy_pass`, a serverless function. Copy the handlers out of `server/index.mjs` together with their allowlists; a bare `proxy_pass` to your RPC is an open relay.

Jito is called directly from the browser and needs no proxy: its block engines send permissive CORS headers.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | Use a paid endpoint in production. Public nodes rate-limit and drop transactions. |
| `PORT` | `8787` | Serves both the static files and the proxies. |

The browser uses the server's `/api/rpc` proxy. There is no settings screen yet; a direct endpoint can only be set per browser by storing `rpcUrl` (an `https://` URL) in the `pumpvault.settings.v1` localStorage entry, and anything else falls back to the proxy.

## Before you put it in front of users

- **Use a paid RPC.** This is the single biggest reliability factor. Launches fail on rate-limited public nodes.
- **Serve over HTTPS.** WebCrypto requires a secure context, so the vault will not work over plain HTTP on a remote host (localhost is exempt).
- **Keep the proxy narrow.** `/api/rpc` forwards only the read and simulate methods the app calls (no `sendTransaction`, no airdrops), and `getProgramAccounts` only as a filtered scan of the two pump programs; `/api/pump/*` serves only the two coin lookups. Each upstream call times out (20 s RPC, 10 s pump.fun, 30 s IPFS) and upstream errors are reported without the RPC URL. Those allowed reads still cost RPC credits, so rate-limit a public deployment at your TLS terminator or CDN. If you copy the handlers to another host, copy the allowlists with them (`RPC_METHODS`, `isAllowedRpcCall`, `pumpApiPath` in `server/index.mjs`).
- **Keep the security headers.** The server sends a Content-Security-Policy (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), `nosniff`, `no-referrer` and `X-Frame-Options: DENY` on every response. A static host serving `dist/` should send the same headers; the policy is `CONTENT_SECURITY_POLICY` in `server/index.mjs`.
- **Check `/api/health`** after deploying: it reports the RPC host and cluster the server is actually using.
