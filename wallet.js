export const phantom = window.phantom?.solana;
const get = id => document.getElementById(id);
const connectButton = get('connect-wallet');
function showWallet(publicKey) {
  const address = publicKey?.toBase58() || '';
  get('wallet-address').textContent = address ? address.slice(0, 6) + '…' + address.slice(-4) : '';
  get('wallet-address').title = address;
  connectButton.textContent = address ? 'Disconnect Phantom' : 'Connect Phantom';
}

export async function connectWallet() {
  if (!phantom) throw Error('Open this page in a browser with Phantom installed.');
  const { publicKey } = await phantom.connect();
  showWallet(publicKey);
  return phantom;
}

phantom?.on('accountChanged', showWallet);
phantom?.on('disconnect', () => showWallet(null));
connectButton.onclick = async () => {
  connectButton.disabled = true;
  get('wallet-address').textContent = '';
  try {
    if (phantom?.isConnected) {
      await phantom.disconnect();
      showWallet(null);
    } else {
      await connectWallet();
    }
  } catch (error) {
    get('wallet-address').textContent = error.message;
  } finally {
    connectButton.disabled = false;
  }
};
showWallet(phantom?.publicKey);

