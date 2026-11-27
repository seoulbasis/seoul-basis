import { phantom, connectWallet } from './wallet.js';

const size = 148;
const timeout = 86400;
const sides = { long: 1, short: 2 };
const get = id => document.getElementById(id);

export async function mountSpreadLock({ rpc, send, account, instruction, config, ata, createAta, mint, token, authority, explorer, commitment }) {
  const { PublicKey, SystemProgram, Keypair, TransactionInstruction } = solanaWeb3;
  const panel = get('spread-lock');
  const status = get('lock-status');
  const create = get('lock-create');
  const inspect = get('lock-inspect');
  const round = get('lock-round');
  const controls = [...panel.querySelectorAll('button')];
  panel.hidden = false;
  const requested = new URLSearchParams(location.search).get('lock');
  if (requested || location.hash === '#spread-lock') panel.open = true;

  let program;
  try {
    const { spreadLockProgramId } = await config;
    if (!spreadLockProgramId) {
      status.textContent = 'Spread Lock funding opens once its Solana mainnet program is deployed.';
      return;
    }
    program = new PublicKey(spreadLockProgramId);
    const { value } = await rpc('getAccountInfo', [program.toBase58(), { commitment }]);
    if (!value?.executable) throw Error('Spread Lock program could not be verified on mainnet.');
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  status.textContent = 'Create a round or inspect a shared Spread Lock address.';
  create.hidden = inspect.hidden = false;
  const address = inspect.elements.market;
  const now = () => Math.floor(Date.now() / 1000);
  const formatTime = value => new Date(value * 1000).toISOString();

  function vaultFor(market) {
    return PublicKey.findProgramAddressSync([new TextEncoder().encode('vault'), market.toBytes()], program)[0];
  }

  async function read(market) {
    const { value } = await rpc('getAccountInfo', [market.toBase58(), { commitment, encoding: 'base64' }]);
    if (value?.owner !== program.toBase58()) throw Error('This address does not belong to the Spread Lock program.');
    const raw = Uint8Array.from(atob(value.data[0]), char => char.charCodeAt(0));
    if (raw.length !== size || raw[0] !== 2) throw Error('This account is not a Spread Lock round.');
    const fields = new DataView(raw.buffer);
    const integer = offset => Number(fields.getBigInt64(offset, true));
    return {
      funded: raw[1], settled: Boolean(raw[2]), claimed: raw[3], expiry: integer(4), payoff: integer(28),
      long: new PublicKey(raw.slice(36, 68)).toBase58(), short: new PublicKey(raw.slice(68, 100)).toBase58(),
      deadline: integer(100), target: integer(108), direction: integer(116), entry: integer(124), timestamp: integer(132),
    };
  }

  function display(market, state) {
    round.hidden = false;
    const phase = state.settled ? 'Settled' : state.timestamp
      ? now() >= state.expiry + timeout ? 'Refunds available' : now() >= state.expiry ? 'Awaiting settlement' : 'Active'
      : now() >= state.deadline ? 'Entry window closed · refunds available' : state.funded === 3 ? 'Awaiting entry attestation' : 'Awaiting funding';
    get('lock-summary').textContent = [
      phase,
      'Trigger: ' + (state.direction === 1 ? 'at or above ' : 'at or below ') + (state.target / 100).toFixed(2) + ' pp',
      'Entry deadline: ' + formatTime(state.deadline),
      'Settlement expiry: ' + formatTime(state.expiry),
      'Long: ' + (state.funded & 1 ? state.long : 'available'),
      'Short: ' + (state.funded & 2 ? state.short : 'available'),
      ...(state.timestamp ? ['Entry: ' + (state.entry / 100).toFixed(2) + ' pp at ' + formatTime(state.timestamp)] : []),
      ...(state.settled ? ['Payouts: long ' + (50 + state.payoff / 10).toFixed(2) + ' USDC · short ' + (50 - state.payoff / 10).toFixed(2) + ' USDC'] : []),
      'Claims: ' + ['none', 'long', 'short', 'both'][state.claimed],
    ].join('\n');
    get('lock-link').href = '/trade?lock=' + market + '#spread-lock';
    get('lock-explorer').href = explorer(market);
    for (const action of ['activate', 'settle']) {
      panel.querySelector('[data-lock="' + action + '"]').hidden = phantom?.publicKey?.toBase58() !== authority;
    }
  }

  async function operate(action) {
    if (action === 'inspect') {
      round.hidden = true;
      const market = new PublicKey(address.value.trim());
      display(market, await read(market));
      return;
    }
    const wallet = await connectWallet();
    const payer = wallet.publicKey;
    let market;
    let signer;
    const instructions = [];
    let description;

    if (action === 'create') {
      const target = Math.round(Number(create.elements.target.value) * 100);
      const direction = Number(create.elements.direction.value);
      const deadline = Math.floor(new Date(create.elements.deadline.value).getTime() / 1000);
      const expiry = Math.floor(new Date(create.elements.expiry.value).getTime() / 1000);
      if (!(deadline > now() && expiry > deadline && expiry <= now() + 30 * timeout)) {
        throw Error('Choose a future entry deadline and a later expiry within 30 days.');
      }
      signer = Keypair.generate();
      market = signer.publicKey;
      const lamports = await rpc('getMinimumBalanceForRentExemption', [size, { commitment }]);
      instructions.push(SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: market, lamports, space: size, programId: program }));
      instructions.push(instruction(program, 5, [account(payer, false, true), account(market, true, true)], [deadline, expiry, target, direction]));
      instructions.push(createAta(payer, vaultFor(market)));
      description = 'Create SOL–BTC Spread Lock at ' + (target / 100).toFixed(2) + ' pp (' +
        (direction === 1 ? 'at or above' : 'at or below') + ').\nEntry deadline: ' + formatTime(deadline) +
        '\nExpiry: ' + formatTime(expiry) + '\nYour wallet pays account rent and the network fee. No USDC is transferred.';
    } else {
      market = new PublicKey(address.value.trim());
      const state = await read(market);
      const keys = [account(payer, false, true), account(market, true)];
      if (action === 'activate' || action === 'settle') {
        if (payer.toBase58() !== authority) throw Error('Connect the Seoul Basis settlement authority.');
        const response = await fetch('/api/market', { cache: 'no-store' });
        if (!response.ok) throw Error('Current price inputs are unavailable.');
        const { prices: { SOL, BTC }, rate, fxDate, time, stale } = await response.json();
        const timestamp = Math.floor(time / 1000);
        const tick = Math.round((SOL.premium - BTC.premium) * 100);
        if (stale || !Number.isSafeInteger(tick) || !Number.isSafeInteger(timestamp) || now() - timestamp > 60 ||
            (action === 'settle' && timestamp < state.expiry)) {
          throw Error('Wait for a fresh market reading.');
        }
        const activate = action === 'activate';
        instructions.push(instruction(program, activate ? 6 : 3, keys, [tick, timestamp]));
        instructions.push(new TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [account(payer, false, true)],
          data: new TextEncoder().encode(JSON.stringify({
            feature: 'Spread Lock', action, market: market.toBase58(), timestamp, tick,
            solKrw: SOL.krw, solUsd: SOL.usd, btcKrw: BTC.krw, btcUsd: BTC.usd, usdKrw: rate, fxDate,
          })),
        }));
        description = 'Attest ' + (activate ? 'entry' : 'settlement') + ' at ' + (tick / 100).toFixed(2) + ' pp.';
      } else {
        const claiming = action === 'claim';
        const vaultAuthority = vaultFor(market);
        const vault = ata(vaultAuthority);
        if (claiming) {
          const owned = Object.entries(sides).find(([side, flag]) => state[side] === payer.toBase58() && (state.funded & flag) && !(state.claimed & flag));
          const refund = now() >= (state.timestamp ? state.expiry + timeout : state.deadline);
          if (!owned || (!state.settled && !refund)) throw Error('No payout or refund is available for this wallet.');
          const amount = state.settled ? 50 + (owned[0] === 'long' ? state.payoff : -state.payoff) / 10 : 50;
          description = 'Claim ' + amount.toFixed(2) + ' USDC to your wallet.';
          instructions.push(createAta(payer, payer));
        } else {
          if (state.funded & sides[action] || now() >= state.deadline || [state.long, state.short].includes(payer.toBase58())) {
            throw Error('This side is unavailable for your wallet.');
          }
          description = 'Fund ' + action + ' with 50 USDC.';
        }
        description += '\nUSDC vault: ' + vault;
        instructions.push(instruction(program, claiming ? 4 : sides[action], [
          ...keys, account(ata(payer), true), account(vault, true), account(mint), account(vaultAuthority), account(token),
        ]));
      }
    }

    status.textContent = 'Checking the mainnet transaction…';
    const result = await send(wallet, [{ instructions, signer }], {
      payer, text: description + '\nRound: ' + market + '\nFee payer: ' + payer,
      statusElement: status,
    });
    if (!result) return;
    address.value = market.toBase58();
    status.textContent = 'Confirmed on Solana mainnet.';
    display(market, await read(market));
  }

  let busy = false;
  async function run(action) {
    if (busy) return;
    busy = true;
    controls.forEach(control => { control.disabled = true; });
    status.textContent = '';
    try { await operate(action); }
    catch (error) { status.textContent = error.message; }
    finally {
      controls.forEach(control => { control.disabled = false; });
      busy = false;
    }
  }
  create.onsubmit = event => { event.preventDefault(); void run('create'); };
  inspect.onsubmit = event => { event.preventDefault(); void run('inspect'); };
  for (const button of panel.querySelectorAll('[data-lock]')) button.onclick = () => run(button.dataset.lock);
  const repaint = () => {
    if (!round.hidden && !busy) void run('inspect');
  };
  phantom?.on('connect', repaint);
  phantom?.on('accountChanged', repaint);
  phantom?.on('disconnect', repaint);
  if (requested) {
    address.value = requested;
    void run('inspect');
  }
}
