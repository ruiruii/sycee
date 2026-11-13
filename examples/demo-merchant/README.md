# SYCEE demo merchant

A first-party merchant run by the SYCEE team. It sells one testnet resource, `GET /v1/base/tip` ($0.001 USDC on Base Sepolia), and records what the SYCEE packages already know how to record:

- `redeem_count` per payment **proof hash** (never the raw proof), including attempts that were refused
- an agent-signed `result.consumed` of `yes`, `no`, or `unknown`

Merchant-signed receipts are always `consumed=unknown`. `unknown` is never counted as `yes`. The yes/no/unknown split is published only when a bucket holds at least 10 agent-signed receipts (`SPEC.md` §8). Below that the page says `not published (k<10)`.

This service does not score anyone, does not take custody of funds, and does not hold a payer key. The x402 facilitator is what submits the buyer's authorization onchain.

The unpaid response is a standard x402 v2 `402` with a base64 `PAYMENT-REQUIRED` header (`scheme: exact`, `network: eip155:84532`). It is not the `gates_spec` challenge that `examples/minimal-server.mjs` emits. A paid retry is counted and receipted by `@sycee/middleware` `createGates`. The `verifyPayment` hook calls the facilitator's `/verify` and `/settle`.

`@sycee/*` is not on npm. Install from the repository root so the workspace links resolve.

## What you must provide

Nothing in this directory is a secret, a funded wallet, or a Cloudflare account. To deploy and to run the live self-test you provide all of the following yourself:

| You provide | Used for |
|---|---|
| A Cloudflare account | `wrangler login`, the Worker, and the D1 database |
| `PAY_TO` | The address that receives testnet USDC. An address you control. Not the Ed25519 signing key. |
| `SYCEE_SIGNING_KEY` | An Ed25519 key (`ed25519-priv:…`) that signs receipts. Generate it locally. It must not equal `PAY_TO`. |
| A buyer test wallet and its private key | Only for `scripts/self-test.mjs`. A different key from `PAY_TO`. |
| Base Sepolia USDC in that buyer wallet | Two payments of $0.001, plus a little headroom. Circle's faucet: <https://faucet.circle.com/> (Base Sepolia, USDC). |

The public facilitator at `https://x402.org/facilitator` submits the transfer and is the party that pays gas. Do not point this demo at mainnet until you have changed the vars below. Mainnet is off unless `MAINNET=true`, and even then the x402.org facilitator is refused because that facilitator is for testnet.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| `GET` | `/` | Public HTML dashboard. No frontend dependencies. |
| `GET` | `/evidence.json` | The same figures as JSON. |
| `GET` | `/.well-known/sycee.json` | Merchant public key, price, network. |
| `GET` | `/health` | Process up. `configured` is false until payTo and the signing key are set. |
| `GET` | `/v1/base/tip` | Paid. Latest Base block number, timestamp, and base fee. |
| `POST` | `/v1/agent-receipt` | An agent-signed VSR. Verified, then linked to the merchant receipt for the same proof hash. |

`redeem_count` counts every presentation of a proof hash, including a refused replay. The counter moves before the accept-or-refuse decision.

Self-test traffic is a **label**, not a login. A request is self-test when it sends `x-sycee-traffic: self-test` or `x-sycee-agent-id: sycee:self-test` (or the agent receipt's `signer.agent_id` is `sycee:self-test`). Anything else is external. Unlabeled calls you made yourself are counted as external. Do not read the external number as independent demand.

The paid route calls only the configured RPC (`eth_getBlockByNumber`, `latest`, without full transactions). Query parameters are ignored. There is no URL you can pass to turn the worker into a proxy. The facilitator URL and the RPC URL are operator configuration, https only (http is accepted only for loopback).

## Local development

From the repository root:

```bash
npm install
npm test
```

The demo tests use a mock facilitator and a mock RPC. They do not touch the network.

An in-memory server (the store dies with the process):

```bash
SYCEE_EPHEMERAL_KEYS=1 \
  PAY_TO=0x2222222222222222222222222222222222222222 \
  npm run demo:merchant
```

`0x2222…2222` is a placeholder for local UI only. It is not a wallet this repository controls, and a real facilitator will not settle to it unless it is actually your address. The ephemeral Ed25519 key is printed as a public key only and changes every start.

Node 22 or newer can use a local SQLite file instead of memory:

```bash
SYCEE_SIGNING_KEY='ed25519-priv:…' \
  PAY_TO=0xYourAddress \
  SQLITE_PATH=./demo-merchant.sqlite \
  node examples/demo-merchant/src/dev-server.mjs
```

`node:sqlite` is not available on Node 18 or 20. Those versions fall back to memory and say so. CI covers the SQLite adapter on Node 22 and skips it on older Node.

Generate a real signing key (print the private key once, then put it in a secret, not in git):

```bash
node --input-type=module -e "import { generateKeyPair } from '@sycee/core'; const k = generateKeyPair(); console.log(k.privateKey); console.log(k.publicKey)"
```

## Cloudflare

Install Wrangler with `npx wrangler` (it is not a dependency of this repo). From `examples/demo-merchant`:

```bash
npx wrangler login
npx wrangler d1 create sycee-demo-merchant
```

Copy the printed `database_id` into `wrangler.toml`. Leave `database_id` as the all-zero placeholder until you do; do not invent one.

```bash
npx wrangler d1 migrations apply sycee-demo-merchant --remote
npx wrangler secret put SYCEE_SIGNING_KEY
```

Set `PAY_TO` in `wrangler.toml` to your address. For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and put the signing key there. `.dev.vars` is gitignored.

```bash
npx wrangler dev
npx wrangler deploy
```

Deploy is yours to run. This repository does not deploy, does not create a Cloudflare account, and does not create a wallet.

Switching to Base mainnet later means all of the following, together. The default config does none of them.

- `MAINNET=true`
- `NETWORK=eip155:8453`
- `ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base mainnet USDC)
- `ASSET_NAME=USD Coin` and `ASSET_VERSION=2` (the token's EIP-712 domain; Sepolia's domain name is `USDC`, mainnet's is `USD Coin`)
- `FACILITATOR_URL` set to a mainnet facilitator. `https://x402.org/facilitator` will be refused. One public option documented by x402 is `https://api.cdp.coinbase.com/platform/v2/x402`.
- `RPC_URL` left unset (it follows the network) or set to a mainnet RPC you trust
- a `PAY_TO` you are willing to receive real USDC at

`PRICE_ATOMIC` defaults to `1000` (6-decimal USDC, so $0.001). `PRICE_DISPLAY` must describe the same amount. The paid route refuses a price above $100 (`100000000` atomic units) rather than charging a typo.

## Self-test

Against a deployed or `wrangler dev` merchant that has a real `PAY_TO`, a real signing key, and D1:

```bash
npm install --no-save --prefix examples/demo-merchant @x402/fetch@2.31.0 @x402/evm@2.31.0 viem@2.57.19
MERCHANT_URL=https://your-worker.example \
  BUYER_EVM_PRIVATE_KEY=0xYourTestnetBuyerKey \
  node examples/demo-merchant/scripts/self-test.mjs
```

The script uses `@x402/fetch` and `@x402/evm` to pay the `PAYMENT-REQUIRED` challenge, then `@sycee/agent-sdk` `createSpend`, `consumedBy`, `notConsumed`, and `linkReceipts` for the two consumption receipts. It replays the same `PAYMENT-SIGNATURE` and expects `402` with `redeem_count` 2 on the evidence page. Every call is labeled self-test. The script prints the buyer address and statuses. It does not print the buyer key or the payment header.

Those npm packages are client tools for this script only. They are not imported by the Worker.

## Honesty rules for self-traffic

- The dashboard splits self-test and external by the label above. The label is not authenticated. A caller can classify itself as self-test; it cannot classify someone else as external if that caller sent the label.
- If you curl the paid route by hand and forget the header, that call is external. Say so if you publish the numbers.
- The SYCEE team's own checks belong in the self-test bucket. Do not add them to a claim about outside demand.
- `redeem_count > 1` includes refused replays. It is not a count of successful sales.
- A published consumed split appears only at k≥10 agent-signed receipts in this deployment's bucket (all-time, this resource, one receipt per proof hash). Merchant receipts do not add to k. `unknown` stays in its own count.

## Workers caveats

- `compatibility_flags = ["nodejs_compat"]` is required. `@sycee/core` signs with `node:crypto` Ed25519 and uses `Buffer`. The Worker does not use `fs`, `net`, `tls`, or `child_process`.
- CPU work per paid request is a SHA-256, one Ed25519 signature, and JSON. The wait is the facilitator `/settle` round trip (a testnet transaction) plus one RPC. On Workers, time spent waiting on `fetch` is not CPU time, but the request still has to finish inside the platform's wall-clock limit. If settle is slow and the isolate is canceled after the facilitator has already broadcast, the buyer may have paid and this service may answer `facilitator_timeout` instead of `200`. A retry of the **same** `PAYMENT-SIGNATURE` is refused and still increments `redeem_count`. The client has to sign a new authorization. This demo is not an idempotent retry.
- Verify, the block read, and settle all run inside `verifyPayment`, before the response bytes are returned. A failed RPC does not settle. A crash in the small window after a successful settle and before the attempt row is written can leave a chain transaction without a dashboard row. The next presentation of that same header is refused, so it is not settled twice.
- D1 writes are not one SQL transaction across the redemption counter and the attempt row. Two overlapping isolates can both observe a count; the `INSERT … ON CONFLICT` makes the counter itself atomic. Do not replace D1 with Workers KV if you care about that.
- The in-memory store is per isolate. Without the D1 binding, counts reset when the isolate dies and are not shared. `wrangler dev` without a migration applied returns `database_not_initialized` on the paid route. Apply the migration (`--local` for dev, `--remote` for deploy).
- The free plan's CPU budget is tight. If a request is killed for CPU, move the Worker to a plan with a higher CPU limit. Do not raise it by pulling more Node APIs into the bundle.
- Receipts and the dashboard store proof hashes, decisions, and (on an accepted settle) the public transaction hash. They do not store the payment payload, the EIP-3009 authorization, or the payer key. The transaction hash is not shown on the public page.
- Rate limit is a fixed one-minute window per `CF-Connecting-IP` (or the first `X-Forwarded-For` hop outside Cloudflare). A configured limit outside 1–10000 is treated as 60. It is a brake, not an authentication boundary.

## Anchoring a receipt on NEAR

The receipt this merchant signs can be hashed and written to a NEAR testnet contract that stores only that hash. The contract does not score, does not hold funds, and does not move funds. The deployed account is `sycee-anchor.testnet` ([deploy transaction](https://testnet.nearblocks.io/txns/J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h)). The walkthrough is [../near-anchor/README.md](../near-anchor/README.md). A browser page that recomputes the hash with no wallet is [../near-anchor/demo/index.html](../near-anchor/demo/index.html).

## Layout

```
examples/demo-merchant/
├── migrations/0001_init.sql   # D1 schema
├── src/worker.mjs             # Workers entry
├── src/dev-server.mjs         # Node entry (memory or sqlite)
├── src/merchant.mjs           # routes, createGates, agent receipts
├── src/x402.mjs               # PAYMENT-REQUIRED and facilitator calls
├── src/store.mjs              # memory + D1
├── src/node-store.mjs         # Node 22 sqlite adapter (not in the Worker graph)
├── scripts/self-test.mjs      # real testnet client
├── test/merchant.test.mjs     # mock facilitator, no network
└── wrangler.toml
```
