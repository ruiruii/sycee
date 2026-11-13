# SYCEE receipt fingerprints on NEAR

A page you can open, with no wallet:

- Local file: [examples/near-anchor/demo/index.html](demo/index.html)
- Public URL: [待填] (TBD). The owner turns on GitHub Pages (source: GitHub Actions) and then runs the workflow named Demo page by hand. After that, the page is expected at `https://ruiruii.github.io/sycee/`. That URL does not exist yet.

This is the English text of [SUBMISSION.zh.md](SUBMISSION.zh.md). The owner's checklist is [提交清单.md](提交清单.md).

## Problem

Machines pay for things on a person's behalf. The track name for that is agent payment. After the payment, how can someone else tell that the receipt was not edited?

SYCEE already issues the receipt. The track name for that receipt is verifiable receipt. The demo merchant, on Base Sepolia, sells one test call, `GET /v1/base/tip`, for 0.001 test USDC. When the payment is accepted, the merchant signs a receipt. The receipt holds hashes and a signature. It does not hold the payment itself.

What was missing is a public time record: this receipt's fingerprint was written down at a known moment. This project does not score anyone, does not hold funds, and does not move funds.

## Solution

The receipt is still produced by the demo merchant on Base Sepolia. This project does one more thing: it copies the receipt's fingerprint onto NEAR testnet. The track name for that step is cross-chain anchoring. One chain produces the receipt. The other stamps the fingerprint with a block time.

The fingerprint uses the same algorithm SYCEE already uses. The receipt is turned into one canonical JSON text, then SHA-256. For the sample receipt in this repo, that value is:

`sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`

That sample is not a payment that happened. The demo page recomputes it with the same algorithm and can match this string with no network.

The contract stores the fingerprint, the source chain (for example `eip155:84532`), the merchant's public payTo address, the block height, the time, and which account wrote it. It does not store the receipt body, the payment proof, or personal data.

Who may write is fixed at deploy. Everyone else can only read. The same fingerprint cannot be written twice.

## What we built on NEAR

The contract is in `contract/`. It does not accept NEAR and it does not send NEAR. In plain language the methods are:

- `new`: at deploy, sets the owner and any other accounts allowed to write. Called once.
- `anchor`: writes one receipt fingerprint. A repeat is rejected. An account that is not on the list is rejected.
- `anchor_batch`: writes up to 32 fingerprints and computes one combined fingerprint (a Merkle root). The contract computes that root. The caller does not get to invent it.
- `get_anchor`: looks up one fingerprint. Returns empty when it was never written.
- `is_anchored`: whether that fingerprint is stored.
- `get_batch`: looks up one combined fingerprint.
- `verify_inclusion`: given one fingerprint and a short proof, checks that it belongs to that combined fingerprint and that this contract stored the batch.
- `add_anchorer` / `remove_anchorer`: the owner adds or removes a writer. The owner cannot be removed.
- `get_owner` / `is_anchorer`: read the owner and the writer list. Anyone can read.

Each write emits a public log in the NEP-297 shape. The log is fingerprints and labels only.

Checking happens in two places. The browser page only recomputes the fingerprint. The Node script `scripts/verify.mjs` also checks the SYCEE signature, then compares the fingerprint on chain. The chain does not check the signature, does not decide whether the payment succeeded, and does not decide whether the buyer used the result.

## Results

These ran on this machine. They are not a plan.

- The contract builds. `bash scripts/build.sh` writes a wasm of **159146 bytes** (`out/sycee_anchor.wasm`).
- 6 Rust unit tests passed (`cargo +1.100.0 test`): write, duplicate rejected, stranger rejected, attached deposit rejected, the owner allows another writer, and the batch fingerprint matches the off-chain check.
- 11 Node unit tests passed: the fingerprint matches `@sycee/core`, the combined fingerprint, the demo page's algorithm, and the deploy script's refusal of mainnet.
- 1 local NEAR sandbox test passed. It covers: write, duplicate rejected, stranger rejected, a missing fingerprint reads back empty, attached NEAR rejected, the public log, a batch root equal to the JavaScript root, `verify_inclusion`, and `scripts/verify.mjs` succeeding against that local chain.
- The demo page opens with a sample receipt filled in. With "离线示例" checked, it computes `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03` and shows that this matches the fingerprint written into the page. That step does not contact testnet.

Still the owner's, not done here:

- Testnet contract account: [待填] (TBD). With a testnet account you already have, run `NEAR_ACCOUNT_ID=your-account.testnet bash scripts/deploy.sh`. This repo does not create an account and does not deploy.
- Mainnet payout account: [待填] (TBD). If the hackathon form asks for a mainnet account for a prize, the owner fills that in. No mainnet account is created here, and nothing is deployed to mainnet.
- Demo post on X: [待填] (TBD). The owner posts it. Nothing is posted from here.
- Public demo URL: [待填] (TBD). See the top of this file. Repository settings were not changed.
