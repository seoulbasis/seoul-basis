# Seoul Basis

Seoul Basis tracks the Korean crypto premium and supports USDC-collateralized premium spread trading on Solana mainnet. Its GIWA Launchpad lets users launch and trade test tokens on GIWA Sepolia.

[Market dashboard](https://seoulbasis.exchange/) · [Spread trading](https://seoulbasis.exchange/trade) · [GIWA Launchpad](https://seoulbasis.exchange/launchpad)

## Korean premium markets

Seoul Basis compares Upbit's KRW price with Coinbase's USD price converted to won using USD/KRW. The premium is the percentage difference between those prices. A pair's spread is the base asset's premium minus the quote asset's premium. If SOL's premium is 3% and BTC's is 2%, the SOL–BTC spread is +1 percentage point.

- **Market analysis** includes Spread Replay, Spread Drivers, Spread Fingerprints, session maps, and the Spread Composer.
- **Spread Vaults** lets Phantom users review and fund an available side in the configured SOL–BTC round, with a USDC cap checked before signing. The existing on-chain round vault holds collateral. The panel shows the connected wallet’s locked collateral and settlement or refund eligibility.
- **Round Queue** shows current, queued, and past rounds per pair. The settlement authority publishes a round by signing a Solana memo in Market setup. New orders default to the earliest open round, and round-specific links preserve access to claims. Alerts appear while the trade page is open. Discovery checks the settlement wallet’s latest 100 transactions, with configured rounds as the baseline.
- **Settlement Challenge Window** gives SOL–BTC a 15-minute review of a signed settlement proposal with timestamped price inputs and payout comparisons. Reviewers can post public, wallet-signed flags. The website checks the window before posting settlement; the deployed program retains its existing settlement rules.
- **Trade planning** includes round depth, a spread stress test, and exit estimates.
- **Trading and settlement** use a Solana wallet. Long and short traders collateralize rounds in USDC. The configured settlement authority submits the final spread, and eligible payouts are claimed from the round's vault.
- **Settlement Replay** lets users review completed rounds and their on-chain settlement data.

The Solana program ID, settlement authority, and market accounts are defined in [mainnet.json](mainnet.json). [View the mainnet program](https://explorer.solana.com/address/A7iECszR9t73CSW9cYzx2SmXeAB89KRxTQ3EZub5EBpm).

## GIWA Launchpad

The launchpad runs on **GIWA Sepolia**, chain ID **91342**. Users can authorize a token launch with a Solana wallet, choose ETH or tKRW as the quote asset, and trade on the bonding curve. tKRW markets also support limit orders. Trade history and candles use executed testnet fills. Launch passports provide token and market details, and the graduation tracker follows progress toward a liquidity pool.

## Run locally

Use Node.js 22 or newer. The core app has no package installation step.

```sh
node server.mjs
```

Open [localhost:3469](http://127.0.0.1:3469/). Set `PORT` to use another port. The server reads live market data and is configured for Solana mainnet, so wallet-approved trading actions can submit real transactions even from localhost.

### Build the GIWA frontend

Place the `solgiwa-indigo` checkout next to this repository and install its dependencies with `pnpm install` in that checkout. Then run the build from this repository:

```sh
./build-launchpad.sh
```

The script requires Bash and Python 3. It builds the themed frontend into the ignored `launchpad/` directory. Open [the local launchpad](http://127.0.0.1:3469/launchpad) after starting the server. Launchpad API calls are proxied to the GIWA backend configured in [giwa-launchpad.mjs](giwa-launchpad.mjs).

## Test and build

```sh
node --test tests/*.cjs
cargo test --manifest-path program/Cargo.toml
```

The JavaScript tests cover exit calculations, fingerprint matching, and spread stress calculations. The Rust program lives in [program/](program/) and can be built with the Solana SBF toolchain using `cargo build-sbf --manifest-path program/Cargo.toml`.

## Web deployment

[vercel.json](vercel.json) configures the Node handler and static launchpad assets. Build the launchpad before uploading the Vercel deployment so the generated files are included. The web deployment uses the existing Solana program and market accounts in `mainnet.json`. Its wallet client expects the Solana Web3 browser bundle at `solana-web3.js` in the deployment root. For local development, the server resolves that bundle from the sibling `shadowpool-solana` checkout instead.

Keep wallet keypairs and environment credentials outside Git.
