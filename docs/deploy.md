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

Anything that can proxy an HTTP request works: a Cloudflare Worker, an nginx `proxy_pass`, a serverless function. Copy the handlers out of `server/index.mjs`; each is a handful of lines.

Jito is called directly from the browser and needs no proxy: its block engines send permissive CORS headers.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | Use a paid endpoint in production. Public nodes rate-limit and drop transactions. |
| `PORT` | `8787` | Serves both the static files and the proxies. |

Users can override the RPC per browser in their own settings; the server default is what everyone else gets.

## Before you put it in front of users

- **Use a paid RPC.** This is the single biggest reliability factor. Launches fail on rate-limited public nodes.
- **Serve over HTTPS.** WebCrypto requires a secure context, so the vault will not work over plain HTTP on a remote host (localhost is exempt).
- **Keep the proxy narrow.** `/api/rpc` forwards whatever JSON body it receives. If your deployment is public, rate-limit it or it becomes an open relay to your paid RPC.
- **Check `/api/health`** after deploying: it reports the RPC host and cluster the server is actually using.
