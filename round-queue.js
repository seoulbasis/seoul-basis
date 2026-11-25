const expiryLabel = new Intl.DateTimeFormat('en-GB', {
  timeZone:'Asia/Seoul', dateStyle:'medium', timeStyle:'short',
});

export function mountRoundQueue(pair, onUpdate) {
  const label = pair.includes('-') ? pair : 'SOL-' + pair;
  const panel = document.getElementById('round-queue');
  const status = panel.querySelector('[role="status"]');
  const rows = panel.querySelector('ul');
  const alerts = panel.querySelector('input');
  const refresh = panel.querySelector('button');
  panel.querySelector('h3').textContent = label.replace('-', '–') + ' Round Queue';
  let last;
  let pending;

  function update() {
    pending ??= (async () => {
      const response = await fetch('/api/round-queue');
      if (!response.ok) throw Error('Queue unavailable');
      const queue = (await response.json())[pair] ?? {};
      const {active, upcoming = [], history = []} = queue;
      rows.replaceChildren();
      for (const [name, round] of [
        ...(active ? [['Current round', active]] : []),
        ...upcoming.map(round => ['Next round', round]),
        ...history.map(round => ['Past round', round]),
      ]) {
        const item = document.createElement('li'), link = document.createElement('a');
        link.href = '/trade?pair=' + encodeURIComponent(pair) + '&market=' + round.address;
        link.textContent = name + ' · ' + round.address.slice(0, 5) + '…' + round.address.slice(-5);
        item.append(link, ' · ' + (name === 'Past round' && round.expiry * 1000 <= Date.now() ? 'Closed ' : 'Funding cutoff ') +
          expiryLabel.format(round.expiry * 1000) + ' KST' +
          (name === 'Current round' ? ' · ' + ['Neither side funded','Long funded','Short funded','Both sides funded'][round.funded] : ''));
        rows.append(item);
      }
      let notice = active ? 'New orders default to the current round.' : 'No open round. Published rounds will appear here.';
      const previous = last?.active;
      if (alerts.checked && last && active) {
        if (previous?.address !== active.address) notice = 'A new ' + label + ' round is open.';
        else if ((active.funded & ~previous.funded) !== 0) notice = 'New collateral was deposited in the current round.';
      }
      if (!alerts.checked || !last || previous?.address !== active?.address || previous?.funded !== active?.funded) {
        status.textContent = notice;
      }
      last = queue;
      onUpdate(queue);
      return queue;
    })().catch(() => {
      status.textContent = 'Round queue unavailable. Try refreshing.';
      return null;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  refresh.addEventListener('click', update);
  setInterval(() => { if (!document.hidden) void update(); }, 30000);
  return update;
}
