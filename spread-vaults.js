import { cash, payout, stateMode } from './exit-math.js';

export function vaultAllocation(market, side, cap, now) {
  if (side !== 'long' && side !== 'short') throw Error('Choose a side.');
  const bit = side === 'long' ? 1 : 2;
  if (!market.vaultAddress) throw Error('This round has no verified USDC vault.');
  if (market.settled || now >= market.expiry) throw Error('This round is closed to new allocations.');
  if (market.funded & bit) throw Error('This side is already funded.');
  if (market.wallet && ((market.funded & 1 && market.long === market.wallet) ||
      (market.funded & 2 && market.short === market.wallet))) {
    throw Error('This wallet has already funded a side in this round.');
  }
  const amount = payout(market.strike, market.contracts, side === 'long');
  if (amount > cash(cap)) throw Error('This side requires more USDC than your per-round cap.');
  return amount;
}

export function usdc(amount) {
  const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return (amount / 1000000n).toLocaleString('en-US') + '.' + fraction + ' USDC';
}

export function mountSpreadVault(panel, marketInput, walletAddress, configuredAddress) {
  const form = panel.querySelector('form');
  const status = panel.querySelector('[role="status"]');
  const review = form.querySelector('button');
  const claim = panel.querySelector('[data-action="vault-claim"]');
  let market;
  let roundAddress;
  configuredAddress.then(address => { roundAddress = address; render(); }).catch(() => {});

  function render() {
    review.disabled = true;
    claim.hidden = true;
    if (!market) {
      status.textContent = 'View the SOL–BTC market to load its on-chain terms.';
      return;
    }
    if (market.market !== roundAddress) {
      status.textContent = 'Select the configured SOL–BTC round to use Spread Vaults.';
      return;
    }
    const side = form.elements.side.value;
    const mode = stateMode(market, Date.now() / 1000);
    const connected = walletAddress();
    const owned = [['long', 1], ['short', 2]].filter(([key, bit]) =>
      connected && market[key] === connected && market.funded & bit);
    const claimable = mode === 'refund' || mode === 'settled';
    claim.hidden = !claimable || !market.vaultAddress || !owned.some(([, bit]) => !(market.claimed & bit));
    const positions = owned.map(([key, bit]) => {
      const collateral = payout(market.strike, market.contracts, key === 'long');
      const entry = key + ' · ' + usdc(collateral) + ' collateral';
      if (!claimable) return entry + ' locked';
      const proceeds = mode === 'settled' ? payout(market.final, market.contracts, key === 'long') : collateral;
      const net = proceeds - collateral;
      return entry + ' · ' + usdc(proceeds) + (market.claimed & bit ? ' claimed' : ' due') +
        ' · ' + (net < 0n ? '−' : '+') + usdc(net < 0n ? -net : net) + ' P/L before network fees';
    });
    panel.querySelector('[data-vault-position]').textContent = positions.join('\n');
    try {
      const amount = vaultAllocation({ ...market, wallet: connected }, side, form.elements.cap.value, Date.now() / 1000);
      status.textContent = usdc(amount) + ' required for the full ' + side + ' side.';
      review.disabled = panel.inert;
    } catch (error) {
      status.textContent = error.message;
    }
  }

  window.addEventListener('seoul-market-inspected', ({ detail }) => {
    if (detail.market !== marketInput.value.trim() || !Number.isInteger(detail.funded)) return;
    market = detail;
    render();
  });
  window.addEventListener('seoul-market-unavailable', () => {
    market = null;
    panel.querySelector('[data-vault-position]').textContent = '';
    render();
  });
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', render);
  setInterval(render, 1000);
  render();

  return () => ({
    market: market?.market,
    side: form.elements.side.value,
    cap: form.elements.cap.value,
  });
}
