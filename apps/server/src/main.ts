import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { JsonSource } from './content/json-source.js';
import { MatchEngine } from './rooms/engine.js';
import { MemoryStore } from './rooms/memory-store.js';
import { registerSocketHandlers } from './sockets/handlers.js';

const PORT = Number(process.env.PORT ?? 3001);
const SEED_DIR = process.env.SEED_DIR ?? fileURLToPath(new URL('../../../content/seed', import.meta.url));
/**
 * Defaults to allowing any origin.
 *
 * The point of this prototype is playing it on five phones, and each of those arrives from
 * `http://192.168.x.x:5173` — an allowlist of `localhost` would reject every one of them and
 * make the thing untestable for exactly the purpose it exists for. Set CLIENT_ORIGIN before
 * this is ever exposed beyond a LAN or a tunnel.
 *
 * In a production deploy this matters much less than it looks: the built client is served
 * from this same process below, so the browser never makes a cross-origin request at all.
 */
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? '*';

/**
 * The built client, served from the game server rather than from a second host.
 *
 * One origin for the page and the websocket is what makes the game deployable to anything
 * that runs a Node process, and what makes a tunnel to one port enough. When the client has
 * not been built the server still runs headless, which is what the tests and `npm run dev`
 * (Vite serving the client itself) both need.
 */
const WEB_DIST = process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

const content = new JsonSource(SEED_DIR);
const store = new MemoryStore();
const engine = new MatchEngine(store, content);

const app = express();
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: store.size() });
});

if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  // A room link is `/?code=XXXXX`, so there are no client-side routes to fall back for —
  // but a refresh on any other path should still land on the game rather than a 404 page.
  app.get('*', (_req, res) => res.sendFile(join(WEB_DIST, 'index.html')));
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    // Wide open in the prototype so a phone on the LAN or a tunnel URL can play without
    // config. Lock this down before anything goes public.
    origin: CLIENT_ORIGIN === '*' ? true : [CLIENT_ORIGIN],
    credentials: true,
  },
});

const stopSweeper = registerSocketHandlers({ io, engine, store, content });

httpServer.listen(PORT, () => {
  console.log(`لعبة شغالة على  http://localhost:${PORT}`);
  console.log(`الأسئلة من: ${SEED_DIR}`);
  console.log(
    existsSync(WEB_DIST)
      ? `الواجهة بتتقدّم من: ${WEB_DIST}`
      : 'الواجهة مش متبنية — شغّل `npm run dev` أو `npm run build`',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopSweeper();
    io.close();
    httpServer.close(() => process.exit(0));
  });
}
