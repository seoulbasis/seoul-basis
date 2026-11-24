const sessions = [
  ['Seoul', 'Asia/Seoul'],
  ['London', 'Europe/London'],
  ['New York', 'America/New_York'],
].map(([name, timeZone]) => ({
  name,
  clock: new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }),
}));

const median = values => {
  const ordered = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};

export function sessionStats(samples, series, dayType) {
  const symbols = (series === 'Spread' ? 'SOL-BTC' : series).split('-');
  const usable = row => row.fx > 0 && Number.isFinite(row.fx) &&
    symbols.every(symbol => ['krw', 'usd'].every(key => {
      const value = row.quotes?.[symbol]?.[key];
      return Number.isFinite(value) && value > 0;
    }));
  return sessions.map(({name, clock}) => {
    let previous;
    let excluded = 0;
    let replayIndex = -1;
    const moves = [];
    const levels = [];
    for (const [index, row] of samples.entries()) {
      const date = new Date(row.time);
      if (!Number.isFinite(+date)) { previous = undefined; continue; }
      const parts = Object.fromEntries(clock.formatToParts(date).map(({type,value}) => [type,value]));
      const weekend = ['Sat', 'Sun'].includes(parts.weekday);
      if (+parts.hour < 9 || +parts.hour >= 17 || weekend !== (dayType === 'weekend')) {
        previous = undefined;
        continue;
      }
      const day = parts.year + parts.month + parts.day;
      if (previous?.day === day) {
        const delta = row.time - previous.row.time;
        if (delta > 0 && delta <= 45000 && usable(row) && usable(previous.row)) {
          moves.push(Math.abs(row[series]) - Math.abs(previous.row[series]));
          replayIndex = index;
          levels.push(Math.abs(row[series]));
        } else {
          excluded++;
        }
      }
      previous = { row, day };
    }
    const latest = levels.at(-1);
    const rank = levels.length > 10 && replayIndex === samples.length - 1
      ? Math.round(100 * levels.slice(0,-1).reduce((sum, value) => sum + (value < latest ? 1 : value === latest ? 0.5 : 0), 0) / (levels.length - 1))
      : null;
    return {
      rank, name, excluded, replayIndex, count: moves.length,
      typical: moves.length >= 10 ? median(moves.map(Math.abs)) : null,
      wider: moves.filter(move => move > 1e-9).length,
      narrower: moves.filter(move => move < -1e-9).length,
    };
  });
}
