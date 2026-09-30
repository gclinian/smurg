import { RELAY_DEV_PROXY_PREFIXES } from '@smurg/protocol/relay';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

// Relay dev server (`pnpm dev:relay`: wrangler dev --env dev). The browser only ever talks to the Vite origin, so the
// relay's session cookie and its WebSocket Origin check see one same-origin app, as in production where the relay
// Worker serves this SPA itself (relay.md §1.4). SMURG_RELAY_DEV_ORIGIN lets parallel checkouts use other ports.
// Keep the SAME hostname as the relay's issuer (localhost): the dev login is only enabled for local hostnames and the
// cookie is per host.
const RELAY_DEV_ORIGIN = process.env['SMURG_RELAY_DEV_ORIGIN'] ?? 'http://127.0.0.1:8787';

const toRelay: ProxyOptions = { target: RELAY_DEV_ORIGIN, ws: true, changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // y-monaco 0.1.6 deep-imports 'monaco-editor/esm/vs/editor/editor.api.js'; monaco >= 0.56's exports map turns
      // that into esm/vs/esm/vs/… and the build fails without this re-mapping (yjs-monaco.md Q2, F16).
      { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: 'monaco-editor/$1' },
    ],
    // One Yjs instance in the bundle: two copies break `instanceof` checks and corrupt documents.
    dedupe: ['yjs', 'y-protocols', 'lib0'],
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    // Same prefixes as the relay's `run_worker_first` (single source: @smurg/protocol/relay).
    proxy: Object.fromEntries(RELAY_DEV_PROXY_PREFIXES.map((prefix) => [prefix, toRelay])),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // scripts/check-chunks.ts reads it to prove Monaco and xterm stay out of the entry chunk.
    manifest: true,
    // Monaco's own lazy chunk is ~4 MB by design (yjs-monaco.md Q2); the entry chunk is checked separately.
    chunkSizeWarningLimit: 4800,
  },
});
