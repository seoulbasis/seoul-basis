import { payout, stateMode } from './exit-math.js';

const get = id => document.getElementById(id);
const explorer = 'https://explorer.solana.com/';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const params = new URLSearchParams(location.search);
let markets = {};
let config;
let active;
let lookupId = 0;

const pp = tick => `${tick > 0 ? '+' : ''}${(tick / 100).toFixed(2)} pp`;
function usdc(value) {
  if (value === null) return '—';
  const abs = value < 0n ? -value : value;
  const fraction = String(abs % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${value < 0n ? '−' : ''}${(abs / 1000000n).toLocaleString()}${fraction ? '.' + fraction : ''}`;
}
async function read(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(16000) });
  if (!response.ok) throw Error('Mainnet data is unavailable. Try again shortly.');
  const data = await response.json();
  if (data?.error) throw Error('Mainnet data is unavailable. Try again shortly.');
  return data;
}
const lookup = (kind, key) => read('/api/settlement-replay?' + new URLSearchParams({ read: kind, key }));

function verifies(tx, round) {
  if (!tx?.meta || tx.meta.err !== null || !Number.isInteger(tx.blockTime)) return false;
  if (tx.blockTime < round.expiry || tx.blockTime >= round.expiry + 86400) return false;
  return tx.transaction.message.instructions.some(ix => {
    if (ix.programId !== config.programId || ix.accounts?.[0] !== config.deploymentAuthority ||
        ix.accounts?.[1] !== round.address || !/^[1-9A-HJ-NP-Za-km-z]{11,13}$/.test(ix.data)) return false;
    let raw = 0n;
    for (const char of ix.data) raw = raw * 58n + BigInt(alphabet.indexOf(char));
    if ((raw >> 64n) !== 3n) return false;
    const bytes = Uint8Array.from({ length: 8 }, (_, index) => Number((raw >> BigInt((7 - index) * 8)) & 255n));
    const submitted = Number(new DataView(bytes.buffer).getBigInt64(0, true));
    return Math.min(500, Math.max(-500, submitted)) === round.final;
  });
}
function showProof(signature, tx) {
  const link = document.createElement('a');
  link.href = explorer + 'tx/' + signature;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'View verified settlement transaction ↗';
  get('proof').replaceChildren(link, ' · ' + new Date(tx.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  const share = new URL(get('share').href);
  share.searchParams.set('signature', signature);
  get('share').href = share;
}
async function findProof(round, signature) {
  get('proof').textContent = 'Checking finalized transaction history…';
  try {
    const signatures = signature ? [signature] : (await lookup('history', round.address))
      .filter(row => !row.err && (row.blockTime === null || (row.blockTime >= round.expiry && row.blockTime < round.expiry + 86400)))
      .slice(0, 10).map(row => row.signature);
    for (const key of signatures) {
      if (active !== round) return;
      const tx = await lookup('proof', key);
      if (active !== round) return;
      if (verifies(tx, round)) {
        showProof(key, tx);
        return;
      }
    }
    if (active === round) get('proof').textContent = signature
      ? 'This signature could not be verified as the round’s settlement.'
      : 'No matching settlement transaction found in recent history. You can verify a signature from the market’s explorer history.';
  } catch (error) {
    if (active === round) get('proof').textContent = error.message;
  }
}
async function loadRound(signature) {
  const id = ++lookupId;
  active = undefined;
  get('result').hidden = true;
  get('load').disabled = true;
  get('status').textContent = 'Reading the finalized market account…';
  try {
    let address;
    try {
      address = new window.solanaWeb3.PublicKey(get('market').value.trim()).toBase58();
    } catch {
      throw Error('Enter a valid Solana market address.');
    }
    const data = await read('/deploy-rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'finalized' }] }),
    });
    if (id !== lookupId) return;
    const account = data.result?.value;
    if (account?.owner !== config.programId) throw Error('This address is not a Seoul Basis market.');
    const bytes = Uint8Array.from(atob(account.data[0]), char => char.charCodeAt(0));
    if (bytes.length !== 100 || bytes[0] !== 1) throw Error('This market is not initialized.');
    const view = new DataView(bytes.buffer);
    const tick = offset => Number(view.getBigInt64(offset, true));
    const round = { address, expiry: tick(4), strike: tick(12), contracts: tick(20), final: tick(28),
      funded: bytes[1], settled: bytes[2] === 1, claimed: bytes[3] };
    const mode = stateMode(round, Date.now() / 1000);
    const label = Object.keys(markets).find(pair => markets[pair] === address);
    get('pair').value = label || '';
    get('round-title').textContent = label ? label.replace('-', ' – ') + ' round' : 'Seoul Basis round';
    get('entry').textContent = pp(round.strike);
    get('final').textContent = round.settled ? pp(round.final) : '—';
    get('expiry').textContent = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(round.expiry * 1000) + ' KST';
    get('contracts').textContent = round.contracts.toLocaleString();
    const rows = [true, false].map(long => {
      const bit = long ? 1 : 2;
      const funded = Boolean(round.funded & bit);
      const collateral = funded ? payout(round.strike, round.contracts, long) : 0n;
      const payment = funded && (round.settled || mode === 'refund')
        ? payout(round.settled ? round.final : round.strike, round.contracts, long) : null;
      const claim = !funded ? 'Unfunded' : round.claimed & bit ? 'Claimed' : payment === null ? 'Pending' : payment === 0n ? 'No payout' : 'Available';
      const row = document.createElement('tr');
      for (const value of [long ? 'Long' : 'Short', usdc(collateral), usdc(payment), usdc(payment === null ? null : payment - collateral), claim]) {
        row.insertCell().textContent = value;
      }
      return row;
    });
    get('payouts').replaceChildren(...rows);
    get('market-link').href = explorer + 'address/' + address;
    get('share').href = '/settlement-replay?' + new URLSearchParams({ market: address });
    history.replaceState(null, '', get('share').href);
    get('verify').hidden = !round.settled;
    get('signature').value = signature || '';
    get('proof').textContent = 'This round has no finalized settlement.';
    get('status').textContent = {
      settled: 'Settled on Solana mainnet', refund: 'Refund period', awaiting: 'Awaiting settlement', matched: 'Open · Both sides funded', unmatched: 'Open · Waiting for funding',
    }[mode];
    get('result').hidden = false;
    active = round;
    if (round.settled) void findProof(round, signature);
  } catch (error) {
    if (id === lookupId) get('status').textContent = error.message;
  } finally {
    if (id === lookupId) get('load').disabled = false;
  }
}

get('lookup').addEventListener('submit', event => {
  event.preventDefault();
  void loadRound();
});
get('verify').addEventListener('submit', event => {
  event.preventDefault();
  const signature = get('signature').value.trim();
  if (active?.settled && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) void findProof(active, signature);
  else get('proof').textContent = 'Enter a valid Solana transaction signature.';
});
get('pair').addEventListener('change', () => {
  get('market').value = markets[get('pair').value] || '';
  if (get('market').value) void loadRound();
  else get('market').focus();
});
get('load').disabled = true;
try {
  config = await read('/mainnet.json');
  markets = Object.fromEntries([['SOL-BTC', config.marketAddress], ...Object.entries(config.pairMarkets || {})
    .map(([pair, address]) => [pair.includes('-') ? pair : 'SOL-' + pair, address])].filter(([, address]) => address));
  for (const pair of Object.keys(markets)) get('pair').add(new Option(pair.replace('-', ' – '), pair));
  get('pair').add(new Option('Custom round address', ''));
  get('market').value = params.get('market') || markets['SOL-BTC'] || '';
  if (get('market').value) void loadRound(params.get('signature'));
  else get('load').disabled = false;
} catch (error) {
  get('status').textContent = error.message;
}
