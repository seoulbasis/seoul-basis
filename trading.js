import { mountSpreadVault, usdc, vaultAllocation } from './spread-vaults.js';
import { payout, stateMode } from './exit-math.js';
import { phantom, connectWallet } from './wallet.js';
const { PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  } = solanaWeb3;
const authority = 'GphtoNwxwkbKdjLmnMrUDs24zuXmyw2ScmZ2DM81RpFr';
const status = document.getElementById('trade-status');
const commitment = 'confirmed';

async function rpc(method, params) {
  const response = await fetch('/deploy-rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
  const { result, error } = await response.json();
  if (error) throw Error(error.message);
  return result;
}

function account(pubkey, isWritable = false, isSigner = false) {
  return { pubkey, isWritable, isSigner };
}

async function send(wallet, plans, review) {
  const { value: lifetime } = await rpc('getLatestBlockhash', [{ commitment }]);
  const transactions = plans.map(({ instructions, signer }) => {
    const tx = new Transaction({ feePayer: wallet.publicKey, blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight }).add(...instructions);
    if (signer) tx.partialSign(signer);
    return tx;
  });
  if (review) {
    const unsigned = transactions[0].serialize({requireAllSignatures:false, verifySignatures:false});
    const { value } = await rpc('simulateTransaction', [
      btoa(String.fromCharCode(...unsigned)), { encoding: 'base64', commitment, sigVerify: false },
    ]);
    if (value.err) throw Error('Solana rejected the preview. Check your balance and refresh the round.');
    if (wallet.publicKey?.toBase58() !== review.payer.toBase58()) throw Error('Wallet changed. Review the allocation again.');
    if (!window.confirm(review.text + '\n\nSolana mainnet simulation passed. Continue to Phantom?')) {
      status.textContent = 'Review cancelled.';
      return false;
    }
  }
  const messages = transactions.map(tx => Array.from(tx.serializeMessage()).join(','));
  const signed = transactions.length === 1
    ? [await wallet.signTransaction(transactions[0])]
    : await wallet.signAllTransactions(transactions);
  if (signed.length > 1 && signed.some((tx, index) =>
    Array.from(tx.serializeMessage()).join(',') !== messages[index])) {
    status.textContent += '\nPhantom changed a batch message. Reviewing the writes individually.';
    for (const plan of plans) await send(wallet, [plan]);
    return;
  }
  const payloads = signed.map((tx, index) => {
    if (Array.from(tx.serializeMessage()).join(',') !== messages[index]) throw Error('Phantom changed a transaction after review. That transaction was not sent.');
    return btoa(String.fromCharCode(...tx.serialize()));
  });

  await Promise.all(payloads.map(async payload => {
    const signature = await rpc('sendTransaction', [payload, { encoding: 'base64', preflightCommitment: commitment }]);
    for (;;) {
      const { value: [receipt] } = await rpc('getSignatureStatuses', [[signature]]);
      if (receipt?.err) throw Error('Transaction failed: ' + signature);
      if (['confirmed', 'finalized'].includes(receipt?.confirmationStatus)) return;
      if (await rpc('getBlockHeight', [{ commitment }]) > lifetime.lastValidBlockHeight) {
        throw Error('Transaction expired: ' + signature);
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }));
  return true;
}

const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const token = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associated = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const get = id => document.getElementById(id);
const ata = owner => PublicKey.findProgramAddressSync([owner.toBytes(), token.toBytes(), mint.toBytes()], associated)[0];
const config = fetch('/mainnet.json').then(response => response.json());
const explorer = address => 'https://explorer.solana.com/address/' + address;
const params = new URLSearchParams(location.search);
const requestedPair = params.get('pair');
const benchmark = ['ETH', 'XRP', 'DOGE', 'ETH-BTC', 'XRP-BTC', 'DOGE-BTC'].includes(requestedPair) ? requestedPair : 'BTC';
const pair = benchmark.includes('-') ? benchmark : 'SOL-' + benchmark;
const [base, quote] = pair.split('-');
const pairLabel = pair.replace('-', '–');
const storageKey = benchmark === 'BTC' ? 'seoul-market' : 'seoul-market-' + pair;
const setupPair = get('setup-pair');
setupPair.value = benchmark;
setupPair.addEventListener('change', () => {
  location.assign('/trade?pair=' + setupPair.value);
});
get('trade-title').textContent = 'Trade the ' + pairLabel + ' spread';
get('market').value = benchmark === 'BTC'
  ? params.get('market') || localStorage.getItem(storageKey) || ''
  : localStorage.getItem(storageKey) || '';
if (benchmark !== 'BTC') get('market').readOnly = true;
const vaultPanel = get('spread-vaults');
const vaultSelection = benchmark === 'BTC' && vaultPanel
  ? mountSpreadVault(vaultPanel, get('market'), () => phantom?.publicKey?.toBase58(), config.then(settings => settings.marketAddress))
  : null;
if (vaultSelection) vaultPanel.hidden = false;



function createAta(payer, owner) {
  return new TransactionInstruction({ programId: associated, data: Uint8Array.of(1), keys: [
    account(payer, true, true), account(ata(owner), true), account(owner), account(mint),
    account(SystemProgram.programId), account(token),
  ] });
}

function instruction(programId, action, keys, values = []) {
  const data = new Uint8Array(1 + values.length * 8);
  data[0] = action;
  values.forEach((value, index) => new DataView(data.buffer).setBigInt64(1 + index * 8, BigInt(value), true));
  return new TransactionInstruction({ programId, keys, data });
}

function spread(id) {
  const input = get(id);
  if (!input.value || !input.checkValidity()) throw Error('Enter a valid spread in percentage points.');
  return Math.round(Number(input.value) * 100);
}

async function run(action) {
  const allocation = action === 'vault-fund';
  const vaultClaim = action === 'vault-claim';
  const selection = allocation || vaultClaim ? vaultSelection?.() : null;
  const programId = new PublicKey((await config).programId);
  const marketInput = get('market');
  const wallet = action === 'inspect' ? phantom : await connectWallet();
  const payer = wallet?.publicKey;
  let signer;
  const instructions = [];
  if (action === 'create') {
    if (payer.toBase58() !== authority) throw Error('Select the settlement authority wallet ending in RpFr.');
    const expiry = Math.floor(new Date(get('expiry').value).getTime() / 1000);
    if (!(expiry > Date.now() / 1000)) throw Error('Choose a future expiry.');
    const strike = spread('strike');
    const contracts = Number(get('contracts').value);
    if (!Number.isInteger(contracts) || contracts < 1 || contracts > 10000) throw Error('Enter 1–10,000 contracts.');
    signer = Keypair.generate();
    marketInput.value = signer.publicKey.toBase58();
    const rent = await rpc('getMinimumBalanceForRentExemption', [100]);
    instructions.push(SystemProgram.createAccount({fromPubkey:payer, newAccountPubkey:signer.publicKey,
      lamports:rent, space:100, programId}));
    instructions.push(instruction(programId, 0, [account(payer,false,true), account(signer.publicKey,true,true)],
      [expiry,strike,contracts]));
  }
  if (!marketInput.value.trim()) throw Error('This pair needs an initialized market and USDC vault.');
  const market = new PublicKey(marketInput.value.trim());
  if ((allocation || vaultClaim) && selection?.market !== market.toBase58()) {
    throw Error('View this round before reviewing a transaction.');
  }
  let review;
  const [vaultAuthority] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault'), market.toBytes()], programId);
  const vault = ata(vaultAuthority);
  if (action === 'create') instructions.push(createAta(payer, vaultAuthority));
  else {
    const { value: [state, vaultInfo] } = await rpc('getMultipleAccounts', [
      [market.toBase58(), vault.toBase58()], { commitment, encoding: 'base64' },
    ]);
    if (state?.owner !== programId.toBase58()) throw Error('This address is not a Seoul Basis market.');
    const data = Uint8Array.from(atob(state.data[0]), char => char.charCodeAt(0));
    if (data.length !== 100 || data[0] !== 1) throw Error('Invalid market state.');
    const fields = new DataView(data.buffer);
    const expiry = Number(fields.getBigInt64(4,true));
    const strike = Number(fields.getBigInt64(12,true));
    const contracts = Number(fields.getBigInt64(20,true));
    const long = new PublicKey(data.slice(36,68));
    const short = new PublicKey(data.slice(68,100));
    const collateral = side => ((500 + (side === 1 ? strike : -strike)) * contracts / 10).toFixed(2);
    get('summary').textContent = 'Expiry ' + new Date(expiry * 1000).toISOString() +
      '\nEntry spread ' + strike / 100 + ' pp · ' + contracts + ' contracts' +
      '\nLong ' + (data[1] & 1 ? long : 'available · ' + collateral(1) + ' USDC collateral') +
      '\nShort ' + (data[1] & 2 ? short : 'available · ' + collateral(2) + ' USDC collateral') +
      '\nSettlement ' + (data[2] ? Number(fields.getBigInt64(28,true)) / 100 + ' pp' : 'pending') +
      '\nClaimed sides ' + (['none','long','short','both'][data[3]] || 'unknown');
    let vaultBalance=0n;
    if(vaultInfo){const raw=Uint8Array.from(atob(vaultInfo.data[0]),c=>c.charCodeAt(0));if(vaultInfo.owner!==token.toBase58()||raw.length!==165||new PublicKey(raw.slice(0,32)).toBase58()!==mint.toBase58()||new PublicKey(raw.slice(32,64)).toBase58()!==vaultAuthority.toBase58())throw Error('Unexpected market vault.');vaultBalance=new DataView(raw.buffer).getBigUint64(64,true);}
    const terms = {market:market.toBase58(),pair:pairLabel,strike,contracts,expiry,funded:data[1],settled:!!data[2],claimed:data[3],final:Number(fields.getBigInt64(28,true)),long:long.toBase58(),short:short.toBase58(),wallet:payer?.toBase58()||null,vaultAddress:vaultInfo?vault.toBase58():null,vaultBalance:vaultBalance.toString(),checkedAt:Date.now()};
    window.dispatchEvent(new CustomEvent('seoul-market-inspected', {detail:terms}));
    get('proof').href = explorer(market);
    get('proof').hidden = false;
    localStorage.setItem(storageKey, market.toBase58());
    if (action === 'inspect') return;
    const keys = [account(payer,false,true), account(market,true)];
    if (action === 'settle') {
      if (payer.toBase58() !== authority) throw Error('Select the settlement authority wallet ending in RpFr.');
      instructions.push(instruction(programId, 3, keys, [spread('settlement')]));
    } else {
      if ((allocation || vaultClaim) && market.toBase58() !== (await config).marketAddress) {
        throw Error('Spread Vaults uses the configured SOL–BTC round.');
      }
      const code = allocation ? (selection.side === 'long' ? 1 : 2) : vaultClaim ? 4 : {long:1, short:2, claim:4}[action];
      if (allocation || vaultClaim) {
        let description;
        if (allocation) {
          const amount = vaultAllocation(terms, selection.side, selection.cap, Date.now() / 1000);
          description = 'Fund the ' + selection.side + ' side with ' + usdc(amount) + '.';
        } else {
          const mode = stateMode(terms, Date.now() / 1000);
          // The program claims long first if the wallet owns both sides.
          const eligible = [['long', 1], ['short', 2]].find(([side, bit]) =>
            terms[side] === payer.toBase58() && terms.funded & bit && !(terms.claimed & bit));
          if (!terms.vaultAddress || !['settled', 'refund'].includes(mode) || !eligible) {
            throw Error('No payout or refund is available for this wallet.');
          }
          const amount = payout(mode === 'settled' ? terms.final : terms.strike, terms.contracts, eligible[0] === 'long');
          description = 'Claim ' + usdc(amount) + ' to your wallet.';
        }
        review = { payer, text: description + '\nRound: ' + market + '\nUSDC vault: ' + vault + '\nFee payer: ' + payer };
      }
      if (code < 3 && (data[1] & code || Date.now() / 1000 >= expiry)) throw Error('This side is unavailable.');
      if (code === 4) instructions.push(createAta(payer, payer));
      instructions.push(instruction(programId, code, [...keys, account(ata(payer),true), account(vault,true),
        account(mint), account(vaultAuthority), account(token)]));
    }
  }
  status.textContent = review ? 'Checking the mainnet transaction…' : 'Review the mainnet transaction in Phantom.';
  if (!await send(wallet, [{ instructions, signer }], review)) return;
  status.textContent = 'Confirmed on Solana mainnet.';
  await run('inspect');
}

for (const control of document.querySelectorAll('[data-action]')) {
  control.onclick = async () => {
    const controls = [...document.querySelectorAll('[data-action]')];
    if (vaultSelection) vaultPanel.inert = true;
    controls.forEach(item => item.disabled = true);
    status.textContent = '';
    try { await run(control.dataset.action); }
    catch (error) { status.textContent = error.message; window.dispatchEvent(new Event('seoul-market-unavailable')); }
    finally {
      controls.forEach(item => item.disabled = false);
      if (vaultSelection) {
        vaultPanel.inert = false;
        vaultPanel.querySelector('form').dispatchEvent(new Event('input'));
      }
    }
  };
}
config.then(({ marketAddress, pairMarkets }) => {
  if (benchmark === 'BTC' && !params.get('market') && marketAddress) get('market').value = marketAddress;
  if (benchmark !== "BTC" && pairMarkets?.[benchmark]) get("market").value = pairMarkets[benchmark];
  if (!get('market').value) {
    get('market-setup').open = true;
    status.textContent = 'Create the ' + pairLabel + ' market and USDC vault with the settlement authority wallet.';
  }
  if (get('market').value) document.querySelector('[data-action=inspect]').click();
}).catch(error => { status.textContent = error.message; });

async function prepareFirstMarket() {
  const expiry = new Date();
  expiry.setUTCHours(16, 0, 0, 0);
  expiry.setUTCDate(expiry.getUTCDate() + ((5 - expiry.getUTCDay() + 7) % 7));
  if (expiry <= new Date()) expiry.setUTCDate(expiry.getUTCDate() + 7);
  const local = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60_000);
  if (!get('expiry').value) get('expiry').value = local.toISOString().slice(0, 16);
  const response = await fetch('/api/market');
  if (!response.ok) throw Error('Live entry spread unavailable. Enter an entry spread to continue.');
  const { prices } = await response.json();
  const entry = prices?.[base]?.premium - prices?.[quote]?.premium;
  if (Number.isFinite(entry) && Math.abs(entry) <= 4.99 && !get('strike').value) {
    get('strike').value = entry.toFixed(2);
  }
}
prepareFirstMarket().catch(error => {
  if (!status.textContent) status.textContent = error.message;
});
