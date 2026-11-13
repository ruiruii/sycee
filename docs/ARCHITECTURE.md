# SYCEE architecture

An agent pays a merchant over x402. The merchant and the agent each sign a receipt. SYCEE fingerprints that signed receipt and a restricted key writes the fingerprint to NEAR. Anyone can check it later.

Solid boxes in the diagram are in this repository today. The dashed boxes are the hosted evidence service: proposed, in pilot with partners, and not a product shipped from this repository. The x402 facilitator is the payment rail. The demo calls it. SYCEE does not take custody and does not move funds.

The slide file is [architecture.svg](./architecture.svg). A raster copy is [architecture.png](./architecture.png).

## Pay

The buyer runtime is [`@sycee/agent-sdk`](../packages/agent-sdk/src/index.mjs). `createSpend` calls an API. On a `402` it pays, retries, and keeps the merchant receipt from the `x-gates-receipt` header.

The demo merchant speaks x402 v2. An unpaid `GET /v1/base/tip` returns `402` with `PAYMENT-REQUIRED`. A paid retry is handled by [`@sycee/middleware`](../packages/middleware/src/index.mjs). The facilitator’s `/verify` and `/settle` are what submit the payment. That code lives in [`examples/demo-merchant/src/x402.mjs`](../examples/demo-merchant/src/x402.mjs). The raw payment payload is sent to the facilitator and is not stored.

The local NEAR walkthrough does not call a live facilitator. [`examples/near-anchor/lib/simulate-pay.mjs`](../examples/near-anchor/lib/simulate-pay.mjs) stands in for verify, settle, and the block read. Its summary says the payment is simulated and that no funds moved.

## Merchant receipt

On a completed call the middleware builds a Verifiable Spend Receipt and signs it with Ed25519 (`signVSR`). The signer role is `merchant`. `result.consumed` is `unknown`, because the seller cannot see whether the buyer used the result. `payment.redeem_count` counts presentations of the same proof hash, including a later presentation that is refused.

The signed envelope is returned as `x-gates-receipt` (base64url of the canonical JSON). The demo merchant is wired in [`examples/demo-merchant/src/merchant.mjs`](../examples/demo-merchant/src/merchant.mjs).

## Agent receipt

`consumedBy` signs `consumed = yes`. `notConsumed` signs `consumed = no`. The signer role is `agent`. `linkReceipts` checks that the merchant receipt and the agent receipt describe the same `proof_hash` and resource.

The demo merchant accepts that agent receipt at `POST /v1/agent-receipt`, verifies it, and links it to the merchant receipt for the same proof hash. The open-source packages already record both `redeem_count` and `consumed`. The hosted copy of that tracking is the planned part below.

## Fingerprint

The anchor hash is `sha256(canonicalJSON({ vsr, signature }))`, using the same functions as [`@sycee/core`](../packages/core/src/index.mjs). The SYCEE spelling keeps the `sha256:` prefix. The contract stores the 64 hex characters. The payment proof is not an input. See [`examples/near-anchor/lib/receipt.mjs`](../examples/near-anchor/lib/receipt.mjs).

## Restricted key

A NEAR function-call access key may call only `anchor` and `anchor_batch` on this contract. Its allowance is gas for those calls. It cannot transfer NEAR, attach a deposit, add a key, or call another method. [`examples/near-anchor/lib/near-sandbox.mjs`](../examples/near-anchor/lib/near-sandbox.mjs) builds that key. `npm run demo:security` shows the allowed call succeeding and the other calls being refused.

## NEAR contract

[`examples/near-anchor/contract/src/lib.rs`](../examples/near-anchor/contract/src/lib.rs) stores the fingerprint, a source-chain label such as `eip155:84532`, a merchant id, the block height, and the block time. It does not store the receipt body or the payment. The same fingerprint cannot be written twice. No method is payable, and the contract never creates a transfer.

`anchor` writes one fingerprint. `anchor_batch` writes up to 32 and stores a Merkle root that the contract computes. The caller does not choose that root. Anyone can call `get_anchor`, `is_anchored`, `get_batch`, and `verify_inclusion`.

The deployed testnet account is `sycee-anchor.testnet`.

## Anyone verifies

`examples/near-anchor/scripts/verify.mjs` checks the Ed25519 signature with `verifyVSR`, reads `get_anchor` over NEAR RPC, and compares the fingerprint. The read does not need a key.

The demo page, [`examples/near-anchor/demo/index.html`](../examples/near-anchor/demo/index.html), recomputes the same SHA-256 in the browser. With offline mode on, it does not use the network. With offline mode off, it calls `https://rpc.testnet.near.org` (`query` / `call_function` / `get_anchor`) and compares the stored fingerprint. The page does not check the signature. That check is `verify.mjs`.

## GitHub Pages

The public page is [https://ruiruii.github.io/sycee/](https://ruiruii.github.io/sycee/). It is the same static file. [`.github/workflows/near-anchor-pages.yml`](../.github/workflows/near-anchor-pages.yml) publishes `examples/near-anchor/demo`. The page reads `hash`, `offline`, and `tx` when `tx` is a full nearblocks transaction URL.

## Hosted evidence service

These four parts are **planned**. The README describes them as a proposed pilot, not a live product in this repository. The diagram draws them with a dashed outline.

| Planned part | What the docs say |
|---|---|
| Receipt storage | An independent copy of receipts that are already signed. |
| Verification dashboard | A hosted place to open and check those receipts. |
| Anchoring service | Anchoring as part of the hosted service. The contract and the scripts in this repository are already built. A hosted anchoring product is not. |
| Redeem and consumed tracking | Phase 1 would record `redeem_count`. Agent-signed `consumed` would come later. |

The demo merchant already has its own first-party page (`GET /` and `GET /evidence.json`). That page is the merchant’s record of its own calls. It is not the hosted third-party service.

## What this does not do

SYCEE does not take custody of funds, does not move funds, and does not score anyone. The NEAR record is a public timestamp of a fingerprint. It does not decide whether the payment succeeded, and it does not decide whether the buyer used the result.
