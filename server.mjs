import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { serveGiwaLaunchpad } from './giwa-launchpad.mjs';

const page = await readFile(new URL('./index.html', import.meta.url));
const engraving = await readFile(new URL('./seoul-engraving.jpg', import.meta.url));
const seal = await readFile(new URL('./seoul-seal.svg', import.meta.url));
let cached;
let pending;
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error('Price source unavailable');
  return response.json();
}
async function snapshot() {
  const symbols = ['BTC', 'SOL', 'ETH', 'XRP', 'DOGE'];
  const [kr, fx, ...quotes] = await Promise.all([
    json('https://api.upbit.com/v1/ticker?markets=' + symbols.map(symbol => 'KRW-' + symbol).join(',')),
    json('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW'),
    ...symbols.map(symbol => json('https://api.coinbase.com/v2/prices/' + symbol + '-USD/spot').catch(() => null)),
  ]);
  const rate = fx.rates.KRW;
  const prices = {};
  for (const [index, symbol] of symbols.entries()) {
    const krw = kr.find(row => row.market === 'KRW-' + symbol)?.trade_price;
    const usd = Number(quotes[index]?.data.amount);
    if ([rate, usd, krw].every(value => Number.isFinite(value) && value > 0)) {
      prices[symbol] = { krw, usd, premium: (krw / (usd * rate) - 1) * 100 };
    }
  }
  if (!prices.SOL || !prices.BTC) throw Error('Core prices unavailable');
  return { prices, rate, fxDate: fx.date, time: Date.now() };
}
let deploymentRpcQueue = Promise.resolve();
async function deploymentRpc(method, params) {
  const request = deploymentRpcQueue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 420));
      const response = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.text();
      const limited = response.status === 429 || /too many requests/i.test(body);
      if (!limited || attempt === 3) return { status: response.status, body };
      const seconds = Number(response.headers.get('retry-after')) || 2 ** (attempt + 1);
      await new Promise(resolve => setTimeout(resolve, Math.min(seconds, 15) * 1000));
    }
  });
  deploymentRpcQueue = request.catch(() => {});
  return request;
}
const basisMint = '9Fu2BFSu97a3dRcrQuWuJnF2h91XiZXqUsy3kntS3XLu';
async function scoutEligibility(wallet) {
  const [prices, response] = await Promise.all([
    json('https://api.jup.ag/price/v3?ids=' + basisMint),
    fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({jsonrpc:'2.0', id:1, method:'getTokenAccountsByOwner',
        params:[wallet, {mint:basisMint}, {encoding:'jsonParsed', commitment:'confirmed'}]}),
      signal: AbortSignal.timeout(8000),
    }),
  ]);
  const price = prices[basisMint]?.usdPrice;
  if (!Number.isFinite(price) || price <= 0 || !response.ok) throw Error('Valuation unavailable');
  const {result} = await response.json();
  if (!Array.isArray(result?.value)) throw Error('Balance unavailable');
  const raw = result.value.reduce((sum, row) => {
    const info = row.account.data.parsed.info;
    if (info.owner !== wallet || info.mint !== basisMint || info.tokenAmount.decimals !== 6) {
      throw Error('Unexpected token account');
    }
    return sum + BigInt(info.tokenAmount.amount);
  }, 0n);
  const usd = Number(raw) / 1e6 * price;
  return { eligible: usd >= 20, usd };
}
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/launchpad' || url.pathname.startsWith('/launchpad/')) return serveGiwaLaunchpad(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/scout-pro') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const wallet = url.searchParams.get('wallet') || '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      res.writeHead(400).end(JSON.stringify({error:'Invalid Solana wallet address.'}));
      return;
    }
    try {
      res.end(JSON.stringify(await scoutEligibility(wallet)));
    } catch {
      res.writeHead(503).end(JSON.stringify({error:'Unable to verify BASIS balance or USD price. Try again shortly.'}));
    }
    return;
  }
  const replayUrl = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && replayUrl.pathname === '/api/settlement-replay') {
    const key = replayUrl.searchParams.get('key') || '';
    const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const options = { commitment: 'finalized' };
    const request = {
      history: ['getSignaturesForAddress', [key, { ...options, limit: 24 }], 32, 44],
      proof: ['getTransaction', [key, { ...options, encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }], 64, 88],
    }[replayUrl.searchParams.get('read')];
    res.setHeader('Content-Type', 'application/json');
    if (!Array.isArray(request) || !base58.test(key) || key.length < request[2] || key.length > request[3]) {
      res.writeHead(400).end(JSON.stringify({ error: 'Invalid settlement lookup' }));
      return;
    }
    try {
      const upstream = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: request[0], params: request[1] }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await upstream.json();
      if (!upstream.ok || data.error) throw Error('RPC unavailable');
      res.setHeader('Cache-Control', data.result === null ? 'no-store' : 'public, s-maxage=30');
      res.end(JSON.stringify(data.result));
    } catch {
      res.writeHead(503).end(JSON.stringify({ error: 'Mainnet transaction history is unavailable. Try again shortly.' }));
    }
    return;
  }
  if (req.url === '/deploy-rpc' && req.method === 'POST') {
    try {
      let input = '';
      for await (const chunk of req) {
        input += chunk;
        if (input.length > 4096) throw Error('Request too large');
      }
      const { method, params } = JSON.parse(input);
      if (!['getLatestBlockhash', 'getBlockHeight', 'getAccountInfo', 'getMultipleAccounts', 'getMinimumBalanceForRentExemption',
        'getSignatureStatuses', 'simulateTransaction', 'sendTransaction'].includes(method)) throw Error('Unsupported RPC method');
      const upstream = await deploymentRpc(method, params);
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(upstream.body);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } }));
    }
    return;
  }
  const deploymentFiles = {
    '/settlement-replay': ['./settlement-replay.html', 'text/html; charset=utf-8'],
    '/settlement-replay.js': ['./settlement-replay.js', 'text/javascript'],
    '/wallet.js': ['./wallet.js', 'text/javascript'],
    '/trading.js': ['./trading.js', 'text/javascript'],
    '/spread-sessions.js': ['./spread-sessions.js', 'text/javascript'],
    '/spread-vaults.js': ['./spread-vaults.js', 'text/javascript'],
    '/round-depth.js': ['./round-depth.js', 'text/javascript'],
    '/exit-planner.js': ['./exit-planner.js', 'text/javascript'],
    '/exit-math.js': ['./exit-math.js', 'text/javascript'],
    '/mainnet.json': ['./mainnet.json', 'application/json'],
    '/deploy': ['./deploy.html', 'text/html'],
    '/deploy.js': ['./deploy.js', 'text/javascript'],
    '/deploy-web3.js': [process.env.VERCEL ? './solana-web3.js' : '../shadowpool-solana/app/dist/vendor/solana-web3.iife.min.js', 'text/javascript'],
    '/deploy-program.so': ['./program/target/deploy/seoul_basis.so', 'application/octet-stream'],
  };
  if (req.method === 'GET' && Object.hasOwn(deploymentFiles, req.url.split('?')[0])) {
    const [path, type] = deploymentFiles[req.url.split('?')[0]];
    try {
      const file = await readFile(new URL(path, import.meta.url));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(file);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (['/', '/trade', '/settlement'].includes(new URL(req.url, 'http://localhost').pathname)) { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(page); return; }
  if (req.url === '/seoul-engraving.jpg') { res.writeHead(200, {'Content-Type':'image/jpeg'}).end(engraving); return; }
  if (req.url === '/seoul-seal.svg') { res.writeHead(200, {'Content-Type':'image/svg+xml'}).end(seal); return; }
  if (req.url === '/api/research') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { spot, at, rolling, last, expiries } = await json('https://hwan.io/api/index');
      res.end(JSON.stringify({ spot, at, rolling: rolling?.value, last: last && {upbit: {value: last.upbit?.value}, bithumb: {value: last.bithumb?.value}, fx: last.fx, value: last.value}, expiries: expiries?.upcoming }));
    } catch {
      res.writeHead(503).end(JSON.stringify({ error: 'Premium feed unavailable.' }));
    }
    return;
  }
  if (req.url !== '/api/market') { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type','application/json');
  res.setHeader('Cache-Control','no-store');
  try {
    if (!cached || Date.now() - cached.time > 12000) {
      pending ??= snapshot().then(value => cached = value).finally(() => pending = undefined);
      await pending;
    }
    res.end(JSON.stringify(cached));
  } catch {
    if (cached) { res.end(JSON.stringify({...cached, stale:true})); return; }
    res.writeHead(503).end(JSON.stringify({error:'Live prices are temporarily unavailable.'}));
  }
}

if (!process.env.VERCEL) http.createServer(handler).listen(Number(process.env.PORT || 3469), '127.0.0.1');
