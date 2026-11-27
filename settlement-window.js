import { payout } from './exit-math.js';

const maximumGap = 45_000;
const minutes = 60_000;
const rules = [
  { label: 'At expiry', length: 0 },
  { label: '5-minute average', length: 5 * minutes },
  { label: '15-minute median', length: 15 * minutes },
];

export function settlementWindows(samples, assets, expiry, entry) {
  const [base, quote] = assets;
  const unique = new Map();
  for (const row of samples) {
    const values = [row.quotes?.[base]?.krw, row.quotes?.[base]?.usd,
      row.quotes?.[quote]?.krw, row.quotes?.[quote]?.usd, row.fx];
    const spread = row[base] - row[quote];
    if (Number.isFinite(row.time) && row.time <= expiry && Number.isFinite(spread) &&
        values.every(value => Number.isFinite(value) && value > 0)) {
      unique.set(row.time, { time: row.time, spread, values });
    }
  }
  const readings = [...unique.values()].sort((a, b) => a.time - b.time);
  const latest = readings.at(-1);
  const collateral = payout(entry, 1, true);
  return rules.map(({ label, length }) => {
    if (!latest || expiry - latest.time > maximumGap) return { label, reason: 'No reading within 45 seconds of expiry.' };
    const start = expiry - length;
    const window = length ? readings.filter(row => row.time >= start) : [latest];
    if (length && (window.length < 2 || window[0].time - start > maximumGap ||
      window.some((row, index) => index > 0 && row.time - window[index - 1].time > maximumGap))) {
      return { label, reason: 'The window has a gap over 45 seconds or too few readings.' };
    }
    const sorted = window.map(row => row.spread).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const spread = length === 15 * minutes
      ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2
      : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const tick = Math.max(-500, Math.min(500, Math.round(spread * 100)));
    const long = payout(tick, 1, true);
    return { label, tick, long, short: payout(tick, 1, false), net: long - collateral, readings: window };
  });
}

export function mountSettlementWindow(samples, pair) {
  const panel = document.getElementById('settlement-window-lab');
  const { expiry, entry } = panel.querySelector('form').elements;
  const status = panel.querySelector('[role="status"]');
  const results = panel.querySelector('[data-window-results]');
  const evidence = panel.querySelector('[data-window-evidence]');
  const formatMoney = value => (Number(value) / 1_000_000).toFixed(2);
  const element = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  let automatic = true;

  function refresh() {
    if (!panel.open) return;
    const { rows, selected } = samples();
    const assets = pair();
    panel.querySelector('[data-window-pair]').textContent = assets.join('–');
    if (automatic && selected) {
      expiry.value = new Date(selected.time - new Date(selected.time).getTimezoneOffset() * minutes).toISOString().slice(0, 19);
    }
    const expanded = new Set([...evidence.querySelectorAll("details[open]")].map(item => item.dataset.rule));
    results.replaceChildren();
    evidence.replaceChildren();
    const time = automatic ? selected?.time : new Date(expiry.value).getTime();
    if (!Number.isFinite(time) || time > Date.now() || !entry.value || !entry.checkValidity()) {
      status.textContent = 'Select a recorded expiry and enter a valid entry spread.';
      return;
    }
    const rules = settlementWindows(rows, assets, time, Math.round(Number(entry.value) * 100));
    const valid = rules.filter(rule => rule.readings);
    const flipped = valid.some(rule => rule.net > 0n) && valid.some(rule => rule.net < 0n);
    status.textContent = flipped ? 'Winner flips across settlement rules.' :
      valid.length < 2 ? 'More continuous browser history is needed to compare rules.' : 'The available rules do not flip the winner.';
    for (const rule of rules) {
      const card = element('div', '');
      card.append(element('dt', rule.label));
      if (rule.reason) {
        card.append(element('dd', rule.reason));
      } else {
        const winner = rule.net === 0n ? 'Break-even' : (rule.net > 0n ? 'Long' : 'Short') + ' gains ' +
          formatMoney(rule.net > 0n ? rule.net : -rule.net) + ' USDC';
        card.append(element('dd', (rule.tick / 100).toFixed(2) + ' pp'), element('p', winner),
          element('small', 'Long payout ' + formatMoney(rule.long) + ' · Short payout ' + formatMoney(rule.short) + ' USDC'));
        const details = element('details', '');
        details.dataset.rule = rule.label;
        details.open = expanded.has(rule.label);
        details.append(element('summary', rule.label + ' · ' + rule.readings.length + ' price inputs'));
        const list = element('ul', '');
        for (const { time, values: [baseKrw, baseUsd, quoteKrw, quoteUsd, fx] } of rule.readings) {
          list.append(element('li', new Date(time).toISOString() + ' · ' + assets[0] + ' ₩' + baseKrw + ' / $' + baseUsd +
            ' · ' + assets[1] + ' ₩' + quoteKrw + ' / $' + quoteUsd + ' · USD/KRW ' + fx));
        }
        details.append(list);
        evidence.append(details);
      }
      results.append(card);
    }
  }
  panel.addEventListener('toggle', refresh);
  expiry.addEventListener('input', () => { automatic = false; refresh(); });
  entry.addEventListener('input', refresh);
  panel.querySelector('form').addEventListener('submit', event => event.preventDefault());
  panel.querySelector('button').onclick = () => { automatic = true; refresh(); };
  return refresh;
}
