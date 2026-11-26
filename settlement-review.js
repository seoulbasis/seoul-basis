import { payout } from './exit-math.js';

export const reviewSeconds = 900;
export const reviewPrefix = 'seoul-review:v1:';
export const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const reasons = {
  calculation:'Spread calculation', solKrw:'SOL Upbit quote', solUsd:'SOL Coinbase quote',
  btcKrw:'BTC Upbit quote', btcUsd:'BTC Coinbase quote', fx:'USD/KRW reference', timing:'Snapshot timing',
};

export function calculatedTick(inputs) {
  const { solKrw, solUsd, btcKrw, btcUsd, fx } = inputs;
  if (![solKrw, solUsd, btcKrw, btcUsd, fx].every(value => Number.isFinite(value) && value > 0)) {
    throw Error('Invalid price inputs.');
  }
  return Math.round(10000 * (solKrw / (solUsd * fx) - btcKrw / (btcUsd * fx)));
}

export async function loadReview(address) {
  const response = await fetch('/api/settlement-review?market=' + encodeURIComponent(address), {cache:'no-store'});
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body;
}

const pp = ticks => (ticks / 100).toFixed(2) + ' pp';
const timestamp = seconds => new Intl.DateTimeFormat('en-GB', {
  timeZone:'Asia/Seoul', dateStyle:'medium',timeStyle:'medium',
}).format(seconds * 1000) + ' KST';

export function mountSettlementReview(marketInput) {
  const panel = document.getElementById('settlement-review');
  const status = panel.querySelector('[role="status"]');
  const evidence = panel.querySelector('dl');
  const reports = panel.querySelector('ul');
  const report = panel.querySelector('[data-action="report-review"]');
  const select = panel.querySelector('select');
  for (const [value,label] of Object.entries(reasons)) select.add(new Option(label,value));
  let pending;

  function render(result) {
    evidence.replaceChildren();
    reports.replaceChildren();
    const proposal = result?.proposals[0];
    report.hidden = !proposal || !result.open;
    if (!proposal) {
      status.textContent = result?.settled ? 'This round settled without a published review.'
        : result?.expiry && Date.now()/1000 < result.expiry
          ? 'Funding closes ' + timestamp(result.expiry) + '. The review starts after a proposal is published.'
          : 'No settlement proposal has been published for this round.';
      return;
    }
    status.textContent = result.settled ? 'Round settled at ' + pp(result.final) + '.'
      : result.open ? 'Review open until ' + timestamp(proposal.at + reviewSeconds) + '.'
      : 'Review period closed.';
    const inputs = proposal.inputs;
    const recalculated = calculatedTick(inputs);
    const payoutPair = tick => [true,false].map(long => Number(payout(tick,result.contracts,long)) / 1000000)
      .map(amount => amount.toFixed(2)).join(' / ') + ' USDC';
    const rows = [
      ['Proposed spread', pp(proposal.tick)], ['Recalculated spread', pp(recalculated)],
      ['Difference', pp(proposal.tick - recalculated)],
      ['SOL · Upbit / Coinbase', '₩' + inputs.solKrw + ' / $' + inputs.solUsd],
      ['BTC · Upbit / Coinbase', '₩' + inputs.btcKrw + ' / $' + inputs.btcUsd],
      ['USD/KRW reference', inputs.fx + ' · ' + inputs.fxDate],
      ['Price snapshot fetched', timestamp(Math.floor(inputs.time / 1000))],
      ['Proposed payouts · Long / Short', payoutPair(proposal.tick)],
      ['Recalculated payouts · Long / Short', payoutPair(Math.min(500,Math.max(-500,recalculated)))],
      ['Previous proposals', String(result.proposals.length - 1)],
    ];
    for (const [name,value] of rows) {
      const cell = document.createElement('div'), title = document.createElement('dt'), text = document.createElement('dd');
      title.textContent = name;
      text.textContent = value;
      cell.append(title,text);
      evidence.append(cell);
    }
    for (const entry of [...result.proposals, ...result.reports]) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = 'https://explorer.solana.com/tx/' + entry.signature;
      link.textContent = entry.inputs ? 'Proposal · ' + pp(entry.tick) + (entry.reason ? ' · Correction: ' + reasons[entry.reason] : '')
        : 'Flag · ' + reasons[entry.reason] + ' · proposal ' + entry.proposal.slice(0, 10) + '…';
      item.append(link, ' · ' + timestamp(entry.at));
      reports.append(item);
    }
  }

  async function refresh() {
    const address = marketInput.value.trim();
    if (pending === address) return;
    pending = address;
    report.hidden = true;
    if (!address) { render(null); pending = undefined; return; }
    status.textContent = 'Checking signed settlement records…';
    try {
      const result = await loadReview(address);
      if (address === marketInput.value.trim()) render(result);
    } catch (error) {
      if (address === marketInput.value.trim()) {
        evidence.replaceChildren();
        reports.replaceChildren();
        status.textContent = error.message;
      }
    } finally {
      if (pending === address) pending = undefined;
    }
  }

  panel.querySelector('[data-review-refresh]').onclick = refresh;
  marketInput.addEventListener('input', refresh);
  window.addEventListener('seoul-market-inspected', ({ detail }) => {
    if (Number.isInteger(detail.funded)) void refresh();
  });
  return refresh;
}
