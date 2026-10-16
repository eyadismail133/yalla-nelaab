import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const GAME_SERVER = process.env.GAME_SERVER_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@game/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@game/rounds': fileURLToPath(new URL('../../packages/rounds/src/index.ts', import.meta.url)),
      '@game/engine': fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // `--host` plus this makes the dev server reachable from phones on the same wifi, which is
    // the only way to find out whether the pacing actually works.
    strictPort: true,
    /**
     * Everything the client needs arrives on one origin, in dev exactly as in production.
     *
     * Without this the page has to guess where the game server lives, and every guess is
     * wrong somewhere: `localhost` breaks on phones, `hostname:3001` breaks behind a tunnel
     * because only 5173 is exposed. Proxying means a tunnel to the web port carries the
     * websocket too, and the client never needs configuring.
     */
    proxy: {
      '/socket.io': { target: GAME_SERVER, ws: true, changeOrigin: true },
      '/health': { target: GAME_SERVER, changeOrigin: true },
    },
  },
});
