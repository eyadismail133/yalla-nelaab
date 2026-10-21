import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = new URL(process.argv[2]);
if (base.origin !== 'https://yalla-nelaab-20261016.web.app') {
  throw new Error('Site identity is restricted to the approved Firebase site');
}
async function fetchAsset(url) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Asset request failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
const html = await fetchAsset(base);
const scripts = [...html.toString().matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)];
if (scripts.length === 0) throw new Error('No deployed entry scripts found');
const identity = [{ file: '/', sha256: createHash('sha256').update(html).digest('hex') }];
for (const [, path] of scripts) {
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    if (url.href === 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3917258623347817') continue;
    throw new Error('Unexpected external entry script');
  }
  identity.push({ file: url.pathname, sha256: createHash('sha256').update(await fetchAsset(url)).digest('hex') });
}
let matchesLocal = null;
if (process.argv.includes('--match-local')) {
  const local = await readFile(new URL('../apps/web/dist/index.html', import.meta.url));
  matchesLocal = createHash('sha256').update(local).digest('hex') === identity[0].sha256;
  for (const entry of identity.slice(1)) {
    if (!/^\/assets\/[\w.-]+\.js$/.test(entry.file)) throw new Error('Unexpected deployed entry path');
    if (!matchesLocal) continue;
    const built = await readFile(new URL(`../apps/web/dist${entry.file}`, import.meta.url));
    matchesLocal &&= createHash('sha256').update(built).digest('hex') === entry.sha256;
  }
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, site: base.origin, matchesLocal, identity }, null, 2));
if (matchesLocal === false) throw new Error('Deployed entry does not match this checkout build');
