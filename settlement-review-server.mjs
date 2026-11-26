const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const reviewPrefix = 'seoul-review:v1:';
const reviewSeconds = 900;
const reasons = new Set(['calculation','solKrw','solUsd','btcKrw','btcUsd','fx','timing']);

function validInputs({solKrw,solUsd,btcKrw,btcUsd,fx}) {
  return [solKrw,solUsd,btcKrw,btcUsd,fx].every(value => Number.isFinite(value) && value > 0) &&
    Number.isSafeInteger(Math.round(10000 * (solKrw / (solUsd * fx) - btcKrw / (btcUsd * fx))));
}

export async function readSettlementReview(address, config, rpc, now = Math.floor(Date.now() / 1000)) {
  const {value} = await rpc('getAccountInfo', [address, {encoding:'base64', commitment:'confirmed'}]);
  const data = value?.owner === config.programId ? Buffer.from(value.data[0], 'base64') : Buffer.alloc(0);
  if (data.length !== 100 || data[0] !== 1) return null;
  const expiry = Number(data.readBigInt64LE(4));
  const settled = Boolean(data[2]);
  if (now < expiry) return {proposals:[], reports:[], open:false, settled, expiry};
  const contracts = Number(data.readBigInt64LE(20));
  const query = (key, limit) => rpc('getSignaturesForAddress', [key, {limit, commitment:'confirmed'}]);
  const [marketHistory, authorityHistory] = await Promise.all([query(address,60), query(config.deploymentAuthority,100)]);
  const candidates = (history, type) => history.filter(row => !row.err && row.memo?.includes(reviewPrefix) &&
    row.memo.includes(address) && row.memo.includes('"type":"' + type + '"')).slice(0,12);
  const history = [...candidates(authorityHistory,'proposal'), ...candidates(marketHistory,'report')];
  const entries = await Promise.all(history.map(async row => {
    const transaction = await rpc('getTransaction', [row.signature, {encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
    const message = transaction?.transaction?.message;
    const ix = message?.instructions.find(item => item.programId === memoProgram &&
      typeof item.parsed === 'string' && item.parsed.startsWith(reviewPrefix));
    const signer = message?.accountKeys[0];
    const at = transaction?.blockTime;
    if (!ix || !signer?.signer || !transaction.meta || transaction.meta.err || !Number.isInteger(at) || at < expiry || at >= expiry + 86400) return null;
    try {
      const entry = JSON.parse(ix.parsed.slice(reviewPrefix.length));
      if (entry.market !== address) return null;
      if (entry.type === 'proposal' && signer.pubkey === config.deploymentAuthority) {
        const x = entry.inputs;
        if (!Number.isInteger(entry.tick) || Math.abs(entry.tick) > 500 ||
            !Number.isInteger(x?.time) || x.time < expiry * 1000 || Math.abs(at * 1000 - x.time) > 300000 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(x.fxDate) || at + reviewSeconds >= expiry + 86400) return null;
        if (!validInputs(x)) return null;
        return {signature:row.signature, tick:entry.tick, inputs:x, reason:reasons.has(entry.reason) ? entry.reason : null, at};
      }
      if (entry.type === 'report' && reasons.has(entry.reason)) {
        return {signature:row.signature, proposal:entry.proposal, reason:entry.reason, at};
      }
    } catch {
      // Malformed records are ignored.
    }
    return null;
  }));
  const proposals = entries.filter(entry => entry?.inputs);
  const reports = entries.filter(entry => entry && !entry.inputs && proposals.some(proposal =>
    proposal.signature === entry.proposal && entry.at >= proposal.at && entry.at < proposal.at + reviewSeconds));
  return {proposals,reports,expiry,settled,contracts,final:Number(data.readBigInt64LE(28)),
    open:!settled && !!proposals[0] && now < proposals[0].at + reviewSeconds};
}
