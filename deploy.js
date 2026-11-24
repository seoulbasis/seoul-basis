const { PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } = solanaWeb3;
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const authority = 'GphtoNwxwkbKdjLmnMrUDs24zuXmyw2ScmZ2DM81RpFr';
const button = document.getElementById('deploy');
const status = document.getElementById('status');
const program = Keypair.generate();
const fundedBuffer = new PublicKey('3Qv7x4zRo3DY26kZSUn4PHAHMDmPeBuJD7zfDDmQtt7U');
const commitment = 'confirmed';
let completed = 0;

async function rpc(method, params) {
  const response = await fetch('/deploy-rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
  const { result, error } = await response.json();
  if (error) throw Error(error.message);
  return result;
}

function loaderInstruction(action, keys, size = 4) {
  const data = new Uint8Array(size);
  new DataView(data.buffer).setUint32(0, action, true);
  return new TransactionInstruction({ programId: loader, keys, data });
}

function account(pubkey, isWritable = false, isSigner = false) {
  return { pubkey, isWritable, isSigner };
}

async function send(wallet, plans) {
  const { value: lifetime } = await rpc('getLatestBlockhash', [{ commitment }]);
  const transactions = plans.map(({ instructions, signer }) => {
    const tx = new Transaction({ feePayer: wallet.publicKey, blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight }).add(...instructions);
    if (signer) tx.partialSign(signer);
    return tx;
  });
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
}

button.onclick = async () => {
  button.disabled = true;
  try {
    const wallet = window.phantom?.solana;
    if (!wallet) throw Error('Open this page in the browser profile with Phantom installed.');
    await wallet.connect();
    const payer = wallet.publicKey;
    if (payer.toBase58() !== authority) throw Error('Select deployment wallet ' + authority);
    const bytes = new Uint8Array(await (await fetch('/deploy-program.so')).arrayBuffer());
    if (bytes[0] !== 127 || bytes[1] !== 69) throw Error('Program binary unavailable.');
    const [programData] = PublicKey.findProgramAddressSync([program.publicKey.toBytes()], loader);
    const info = key => rpc('getAccountInfo', [key.toBase58(), { commitment, encoding: 'base64' }]);
    const rent = size => rpc('getMinimumBalanceForRentExemption', [size]);
    const [programRent, dataRent] = await Promise.all([rent(36), rent(45 + bytes.length)]);
    const existing = (await info(fundedBuffer)).value;
    const existingBytes = existing ? Uint8Array.from(atob(existing.data[0]), byte => byte.charCodeAt(0)) : null;
    if (!existingBytes || existing.owner !== loader.toBase58() ||
        existingBytes.length !== bytes.length + 37 ||
        new DataView(existingBytes.buffer).getUint32(0, true) !== 1 ||
        existingBytes[4] !== 1 ||
        !new PublicKey(existingBytes.slice(5, 37)).equals(payer)) {
      throw Error('The funded deployment buffer is unavailable. Check its on-chain status before continuing.');
    }
    const uploadBuffer = fundedBuffer;
    status.textContent = 'Program '  + program.publicKey + '\nBuffer ' + uploadBuffer +
      '\nEstimated program rent: ' + (dataRent + programRent) / 1e9 + ' SOL plus fees. Keep this tab open.';
    if ((await info(program.publicKey)).value?.executable) {
      status.textContent += '\nProgram already deployed.';
      return;
    }
    const writes = [];
    for (let offset = completed; offset < bytes.length; offset += 900) {
      const chunk = bytes.subarray(offset, offset + 900);
      if (chunk.every((byte, index) => existingBytes[37 + offset + index] === byte)) continue;
      const ix = loaderInstruction(1, [account(uploadBuffer, true), account(payer, false, true)], 16 + chunk.length);
      const fields = new DataView(ix.data.buffer);
      fields.setUint32(4, offset, true);
      fields.setBigUint64(8, BigInt(chunk.length), true);
      ix.data.set(chunk, 16);
      writes.push({ instructions: [ix], end: offset + chunk.length });
    }
    for (let index = 0; index < writes.length; index += 5) {
      const batch = writes.slice(index, index + 5);
      await send(wallet, batch);
      completed = batch.at(-1).end;
      status.textContent += '\nUploaded ' + completed + ' / ' + bytes.length + ' bytes';
    }
    const deploy = loaderInstruction(2, [account(payer, true, true), account(programData, true),
      account(program.publicKey, true), account(uploadBuffer, true), account(SYSVAR_RENT_PUBKEY),
      account(SYSVAR_CLOCK_PUBKEY), account(SystemProgram.programId), account(payer, false, true)], 12);
    new DataView(deploy.data.buffer).setBigUint64(4, BigInt(bytes.length), true);
    await send(wallet, [{ signer: program, instructions: [
      SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: program.publicKey,
        lamports: programRent, space: 36, programId: loader }), deploy,
    ] }]);
    if (!(await info(program.publicKey)).value?.executable) throw Error('Executable account is still being confirmed.');
    status.textContent += '\nVerified executable program: ' + program.publicKey;
  } catch (error) {
    status.textContent += '\n' + error.message;
  } finally {
    button.disabled = false;
  }
};
