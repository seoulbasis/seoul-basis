import { payout, stateMode } from './exit-math.js';

const panel = document.getElementById('round-depth');
const marketInput = document.getElementById('market');
const get = name => panel.querySelector('[data-depth="' + name + '"]');
const inspect = document.querySelector('[data-action="inspect"]');
let market;

function usdc(amount) {
  const whole = (amount / 1000000n).toLocaleString('en-US');
  const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return whole + '.' + fraction + ' USDC';
}

function render() {
  const details = get('details');
  details.hidden = !market;
  if (!market) return;
  const now = Date.now() / 1000;
  const mode = stateMode(market, now);
  const longRequired = payout(market.strike, market.contracts, true);
  const shortRequired = payout(market.strike, market.contracts, false);
  const longFunded = Boolean(market.funded & 1);
  const shortFunded = Boolean(market.funded & 2);
  for (const [name, funded, required, bit] of [
    ['long', longFunded, longRequired, 1], ['short', shortFunded, shortRequired, 2],
  ]) {
    get(name).textContent = usdc(funded ? required : 0n) + ' deposited';
    get(name + '-status').textContent = funded
      ? (market.claimed & bit ? 'Claimed' : 'Funded')
      : now < market.expiry && !market.settled ? usdc(required) + ' needed' : 'Unfunded · Closed';
  }
  const remaining = (longFunded ? 0n : longRequired) + (shortFunded ? 0n : shortRequired);
  get('status').textContent = {
    unmatched: usdc(remaining) + ' still needed to match the round',
    matched: 'Both sides funded · Awaiting expiry',
    awaiting: 'Both sides funded · Awaiting settlement',
    refund: market.funded & ~market.claimed ? 'Funding closed · Refunds available' : 'Funding closed',
    settled: market.funded & ~market.claimed ? 'Settled · Payout claims open' : 'Settled · Claims complete',
  }[mode];
  const cutoff = new Intl.DateTimeFormat('en-GB', {dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(market.expiry * 1000);
  get('expiry').textContent = (now < market.expiry ? 'Funding closes ' : 'Funding closed ') + cutoff + ' KST';
  get('balance').textContent = market.vaultAddress ? usdc(BigInt(market.vaultBalance)) : 'Vault unavailable';
  const vault = get('vault');
  vault.hidden = !market.vaultAddress;
  if (market.vaultAddress) vault.href = 'https://explorer.solana.com/address/' + market.vaultAddress;
  get('source').textContent = market.pair + ' · Solana mainnet · Checked ' + new Date(market.checkedAt).toLocaleTimeString();
}

window.addEventListener('seoul-market-inspected', ({ detail }) => {
  if (detail.market !== marketInput.value.trim()) return;
  market = detail;
  render();
});
window.addEventListener('seoul-market-unavailable', () => {
  market = null;
  get('status').textContent = 'Market funding unavailable. Refresh to check the round.';
  render();
});
get('refresh').addEventListener('click', () => inspect.click());
setInterval(render, 15000);
