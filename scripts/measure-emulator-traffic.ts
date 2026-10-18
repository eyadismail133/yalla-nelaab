import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { ROUND_TYPES } from '@game/rounds';
import { JsonSource } from '../apps/server/src/content/json-source.js';
import { FirebaseTransport } from '../apps/web/src/net/firebase-transport.js';
import { DRIVERS, mulberry32 } from '../packages/rounds/src/test-drivers.js';

if (process.env.FIREBASE_DATABASE_EMULATOR_HOST !== '127.0.0.1:9000' ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') {
  throw new Error('Run only through the local Auth/RTDB emulator command on ports 9000/9099');
}

// Count application WebSocket payload bytes only. Packet contents never leave these callbacks.
const counts = { sentBytes: 0, receivedBytes: 0, sentFrames: 0, receivedFrames: 0 };
const errors: Error[] = [];
const upstreams = new Set<WebSocket>();
const server = createServer((incoming, outgoing) => {
  const upstream = request({ hostname: '127.0.0.1', port: 9000, path: incoming.url,
    method: incoming.method, headers: { ...incoming.headers, host: '127.0.0.1:9000' } }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', (error) => { errors.push(error); outgoing.destroy(); });
  incoming.pipe(upstream);
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (client, incoming) => {
  const upstream = new WebSocket(`ws://127.0.0.1:9000${incoming.url}`);
  upstreams.add(upstream);
  const queued: Buffer[] = [];
  client.on('message', (data) => {
    const packet = Buffer.from(data.toString());
    counts.sentBytes += packet.length; counts.sentFrames += 1;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(packet.toString());
    else queued.push(packet);
  });
  upstream.on('open', () => { for (const packet of queued) upstream.send(packet.toString()); queued.length = 0; });
  upstream.on('message', (data) => {
    const packet = Buffer.from(data.toString());
    counts.receivedBytes += packet.length; counts.receivedFrames += 1;
    if (client.readyState === WebSocket.OPEN) client.send(packet.toString());
  });
  client.on('close', () => { upstream.terminate(); });
  upstream.on('close', () => { upstreams.delete(upstream); client.close(); });
  client.on('error', (error) => errors.push(error));
  upstream.on('error', (error) => errors.push(error));
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(9001, '127.0.0.1', resolve);
});

const source = new JsonSource(fileURLToPath(new URL('../content/seed', import.meta.url)), mulberry32(42));
const categories = (await source.categories()).map((category) => category.id);
const rows: object[] = [];
const runId = randomUUID().slice(0, 8);

async function measure(label: object, action: () => Promise<{ ok: boolean; error?: string }>) {
  const before = { ...counts };
  const started = performance.now();
  const result = await action();
  const acknowledgedMs = performance.now() - started;
  await pause(100);
  if (errors.length) throw new AggregateError(errors, 'Traffic proxy failed');
  if (counts.sentFrames === before.sentFrames || counts.receivedFrames === before.receivedFrames) {
    throw new Error('Measured operation bypassed the counting proxy');
  }
  const delta = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key as keyof typeof counts]]));
  rows.push({ ...label, accepted: result.ok, acknowledgedMs, ...delta });
  if (!result.ok) throw new Error(`Measured operation failed: ${result.error}`);
}

function transport(seat: string) {
  return new FirebaseTransport({
    seatId: seat, contentSource: source, storage: null, channel: null,
    config: { apiKey: 'fake-api-key-demo', authDomain: 'demo-yalla-nelaab.firebaseapp.com',
      databaseURL: 'http://127.0.0.1:9001?ns=demo-yalla-nelaab-default-rtdb',
      projectId: 'demo-yalla-nelaab', appId: '1:123456789:web:abcdef123456' },
    databaseEmulatorHost: '127.0.0.1:9001', authEmulatorHost: '127.0.0.1:9099',
  });
}

try {
  for (const type of ROUND_TYPES) {
    for (const count of [2, 4, 8]) {
      if (count < type.minPlayers) {
        rows.push({ type: type.id, players: count, unsupported: `requires ${type.minPlayers} players` });
        continue;
      }
      const clients = Array.from({ length: count }, (_, index) => transport(`bw-${runId}-${type.id}-${count}-${index}`));
      const host = clients[0]!;
      const label = { type: type.id, players: count };
      try {
        const created = await host.createRoom('benchmark-host', { format: 'focused', roundTypeId: type.id,
          roundCount: 5, categoryIds: categories, teams: type.requiresTeams });
        if (!created.ok) throw new Error(created.error);
        for (const [index, client] of clients.slice(1).entries()) {
          const joined = await client.joinRoom(created.code, `benchmark-${index}`);
          if (!joined.ok) throw new Error(joined.error);
        }
        await pause(100);
        await measure({ ...label, action: 'start' }, () => host.start());
        await measure({ ...label, action: 'captain' }, () => host.act(1, { kind: 'card', card: 'double_captain' }));
        const skipped = await host.skip();
        if (!skipped.ok) throw new Error(skipped.error);
        if (['mcq_race', 'numeric_guess'].includes(type.id)) {
          await measure({ ...label, action: 'var' }, () => host.act(1, { kind: 'card', card: 'var' }));
        }
        const state = (await host.getHostRuntime()!.getStore().get(created.code))!;
        const action = DRIVERS[type.id]!.randomAction(mulberry32(42), 0, state.roundState, state.hostId);
        await measure({ ...label, action: 'first-progress' }, () => host.act(1, action));
        if (count < 8) {
          const spectator = transport(`bw-${runId}-${type.id}-${count}-s`);
          clients.push(spectator);
          await measure({ ...label, action: 'spectator-join' }, () => spectator.joinRoom(created.code, 'benchmark-spectator'));
        }
      } finally {
        for (const client of clients.slice(1)) await client.leave();
        await host.leave();
        for (const client of clients) client.dispose();
        await pause(100);
      }
    }
  }
  const report = JSON.stringify({
    scope: 'Actual Firebase SDK traffic through a loopback RTDB WebSocket proxy with real authored questions and real demo-project rules. Counts application payload UTF-8 bytes/frames across all room clients, including snapshots, projections, commands, acknowledgements, cleanup and incidental heartbeats within operation plus 100 ms. Excludes HTTP requests (including Auth), WebSocket/TCP/TLS headers and compression. Not billed bytes or physical-network ping. Single current-candidate sample per action; no before/after bandwidth reduction claim.',
    rows,
  }, null, 2);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(report + '\n', (error) => error ? reject(error) : resolve());
  });
} finally {
  for (const client of sockets.clients) client.terminate();
  for (const upstream of upstreams) upstream.terminate();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
// Firebase's Node SDK retains housekeeping timers after the apps and proxy close.
// All measurements and cleanup above must succeed, and stdout is flushed, before exit.
process.exit(0);
