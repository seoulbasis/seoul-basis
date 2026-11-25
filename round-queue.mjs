export const roundMemoPrefix = 'seoul-basis:round:v1:';
const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const pairs = ['BTC', 'ETH', 'XRP', 'DOGE', 'ETH-BTC', 'XRP-BTC', 'DOGE-BTC'];

export async function readRoundQueue(config, rpc) {
  const history = await rpc('getSignaturesForAddress', [config.deploymentAuthority, {limit:100, commitment:'confirmed'}]);
  const published = await Promise.all(history.filter(entry => !entry.err && entry.memo?.includes(roundMemoPrefix)).slice(0, 24)
    .map(async ({signature}) => {
      const tx = await rpc('getTransaction', [signature, {encoding:'jsonParsed', commitment:'confirmed', maxSupportedTransactionVersion:0}]);
      const message = tx?.transaction.message;
      const ix = message?.instructions.find(item => item.programId === memoProgram &&
        typeof item.parsed === 'string' && item.parsed.startsWith(roundMemoPrefix));
      if (!ix || tx.meta?.err || !message.accountKeys.some(key => key.signer && key.pubkey === config.deploymentAuthority)) return null;
      const [pair, address, extra] = ix.parsed.slice(roundMemoPrefix.length).split(':');
      if (extra !== undefined || !pairs.includes(pair) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
      return {pair, address};
    }));
  const entries = [{pair:'BTC', address:config.marketAddress},
    ...Object.entries(config.pairMarkets).map(([pair,address]) => ({pair,address})),
    ...Object.entries(config.pastRounds ?? {}).flatMap(([pair, list]) => list.map(address => ({pair,address, archived:true}))),
    ...published.filter(Boolean)];
  const addresses = [...new Set(entries.map(entry => entry.address))];
  const {value} = await rpc('getMultipleAccounts', [addresses, {encoding:'base64', commitment:'confirmed'}]);
  const rounds = {};
  const now = Date.now() / 1000;
  for (const [index, address] of addresses.entries()) {
    const account = value[index];
    const {pair, archived = false} = entries.find(entry => entry.address === address);
    if (account?.owner !== config.programId) continue;
    const data = Buffer.from(account.data[0], 'base64');
    if (data.length !== 100 || data[0] !== 1) continue;
    const expiry = Number(data.readBigInt64LE(4));
    (rounds[pair] ??= []).push({address, expiry, funded:data[1], archived, settled:!!data[2]});
  }
  return Object.fromEntries(Object.entries(rounds).map(([pair, markets]) => {
    markets.sort((a,b) => a.expiry - b.expiry || a.address.localeCompare(b.address));
    const [active, ...upcoming] = markets.filter(round => !round.archived && !round.settled && round.expiry > now);
    return [pair, {active, upcoming, history:markets.filter(round => round.archived || round.settled || round.expiry <= now).reverse()}];
  }));
}
