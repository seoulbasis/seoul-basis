import { readFile } from 'node:fs/promises';

const giwaOrigin = 'https://solgiwa-indigo.vercel.app';
const reads = new Set(['graduation', 'launches', 'market-trades', 'passport', 'position']);
const intents = new Set(['launch-intent', 'trade-intent']);
const contentTypes = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', webp: 'image/webp', json: 'application/json',
};

export async function serveGiwaLaunchpad(req, res, url) {
  if (url.pathname.startsWith('/launchpad/api/')) {
    const endpoint = url.pathname.slice('/launchpad/api/'.length);
    const isIntent = intents.has(endpoint);
    if (!isIntent && !reads.has(endpoint)) return res.writeHead(404).end();
    if (req.method !== (isIntent ? 'POST' : 'GET')) return res.writeHead(405).end();
    try {
      let body;
      if (isIntent) {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return res.writeHead(415).end();
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return res.writeHead(403).end();
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > 3 * 1024 * 1024) return res.writeHead(413).end();
          chunks.push(bytes);
        }
        body = Buffer.concat(chunks);
      }
      const upstream = await fetch(`${giwaOrigin}/api/${endpoint}${url.search}`, {
        method: req.method,
        headers: isIntent ? { 'Content-Type': 'application/json' } : {},
        body, redirect: 'error', signal: AbortSignal.timeout(45000),
      });
      return res.writeHead(upstream.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': isIntent ? 'no-store' : upstream.headers.get('cache-control') ?? 'no-store',
      }).end(await upstream.text());
    } catch {
      return res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ error: 'GIWA Sepolia service unavailable. Check your transaction status before retrying.' }));
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  const asset = url.pathname === '/launchpad' || url.pathname === '/launchpad/'
    ? 'index.html' : url.pathname.slice('/launchpad/'.length);
  const extension = asset.split('.').at(-1);
  if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(asset) || !contentTypes[extension]) return res.writeHead(404).end();
  try {
    const file = await readFile(new URL('./launchpad/' + asset, import.meta.url));
    return res.writeHead(200, {
      'Content-Type': contentTypes[extension],
      'Cache-Control': asset.startsWith('giwa-assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    }).end(req.method === 'HEAD' ? undefined : file);
  } catch {
    return res.writeHead(404).end();
  }
}
