import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const API_PORT = process.env.PORT || 8787;

/** Serve `/launch` in dev exactly as the production server does, so links need no dev-only branch. */
function cleanUrls() {
  const pages = ['launch', 'claim', 'rescue'];
  return {
    name: 'pumpvault-clean-urls',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url.split('?')[0].replace(/\/$/, '');
        if (pages.includes(path.slice(1))) req.url = `${path}.html${req.url.slice(path.length)}`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    cleanUrls(),
    nodePolyfills({ include: ['buffer', 'process'], globals: { Buffer: true, process: true } }),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        launch: resolve(__dirname, 'launch.html'),
        claim: resolve(__dirname, 'claim.html'),
        rescue: resolve(__dirname, 'rescue.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
});
