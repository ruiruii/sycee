# NEAR anchor for SYCEE receipts

A NEAR contract that stores hashes of SYCEE receipts. The Base Sepolia demo merchant (`examples/demo-merchant/`) sells `GET /v1/base/tip` and signs a Verifiable Spend Receipt. This example takes that receipt, hashes it the same way `@sycee/core` hashes, and asks an allowlisted account to write the hash on NEAR testnet.

The chain record is a timestamped log. Any agent can recompute the hash and read it back. The contract does not score anyone, does not take custody, and does not move funds. It stores hashes, a chain label such as `eip155:84532`, a merchant id (the demo's public `payTo`), the block height, and the block timestamp. It does not store the receipt body, the payment proof, or a payer key.

The deployed testnet contract is `sycee-anchor.testnet`. The owner is `sycee-anchor.testnet` and `anchorers` is empty. That deployment is commit `01b4e419`, wasm 159146 bytes, sha256 `c027e046864760b51848501cec91c5c0b4e738d6dc94de86ce63d3d0ae98a236`. Deploy transaction: [J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h](https://testnet.nearblocks.io/txns/J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h). Nothing in this directory creates a NEAR account. Mainnet is refused.

## Receipt hash

```
receipt_hash = sha256(canonicalJSON({ vsr, signature }))
```

`sha256` and `canonicalJSON` are the functions from `@sycee/core`. The `sha256:` prefix is the SYCEE spelling. The contract stores the 64 hex characters and accepts either form. This is the hash of the signed envelope, not `payment.proof_hash` (that one is the hash of the payment proof, which never enters this directory).

The public `/evidence.json` page truncates proof hashes. The anchor script will not treat those rows as receipts. Pass the VSR itself: the JSON envelope, or the `x-gates-receipt` base64url header the middleware already produces from `canonicalJSON(envelope)`.

## What a caller can do

| Method | Who | What it does |
|---|---|---|
| `new(owner, anchorers)` | deploy | Sets the owner. The owner can write. Optional extra writer accounts. |
| `anchor(receipt_hash, source_chain, merchant_id, batch_root)` | owner or allowlist | Stores one hash. Rejects duplicates, strangers, and attached NEAR. |
| `anchor_batch(receipt_hashes, source_chain, merchant_id)` | owner or allowlist | Stores up to 32 hashes and the Merkle root this contract computes. |
| `get_anchor(receipt_hash)` | anyone | The record, or null. |
| `is_anchored(receipt_hash)` | anyone | True if that hash is stored. |
| `get_batch(batch_root)` | anyone | The batch record, or null. |
| `verify_inclusion(receipt_hash, proof, batch_root)` | anyone | True when the proof rebuilds that root and this contract stored the batch. |
| `add_anchorer` / `remove_anchorer` | owner | Changes the writer list. The owner cannot be removed. |
| `get_owner` / `is_anchorer` | anyone | Read the writer list. |

Each write emits a [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) log: `standard` `sycee-anchor`, `version` `1.0.0`, event `anchor` or `anchor_batch`. The log is hashes and labels only.

`batch_root` on a single `anchor` must already exist. `anchor_batch` computes the root itself. Leaf = SHA-256(`0x00` ‖ receipt-hash bytes). Internal node = SHA-256(`0x01` ‖ min ‖ max), with the leaf hashes sorted before pairing. An odd node is promoted. The JavaScript in `lib/merkle.mjs` matches the contract; the sandbox test checks that.

No method is payable. The SDK rejects an attached deposit before the method body runs (`Method anchor doesn't accept deposit`). The account that holds the contract still needs a little testnet NEAR for storage rent. That rent is locked by the protocol on the account. This code never transfers it.

## Threat model and limits

What this gives you: a public statement that account A wrote hash H at NEAR block height T, and that a second write of H was rejected.

What this does not give you:

- It does not check the Ed25519 signature. `scripts/verify.mjs` does that off-chain with `verifyVSR`, then compares the hash to `get_anchor`. The demo page only recomputes the hash.
- It does not prove the payment happened. The receipt's own `proof_hash` is already a hash. The raw proof is not an input.
- It does not prove the buyer consumed the result. A merchant receipt is `consumed = unknown`.
- A writer on the allowlist can anchor any 32-byte string. The log shows which account did it. It is not a court, and it is not a score.
- Labels are short (`source_chain` ≤ 64, `merchant_id` ≤ 128) and reject strings that look like payment material. That is a size-and-shape check, not a guarantee about the bytes that were hashed off-chain.
- Testnet is the only network the deploy script will talk to. Mainnet is refused. No account is created here.

## Demo page

`demo/index.html` is one static file. Open it. It is prefilled with `fixtures/sample-receipt.json`, which is a signed sample shaped like a demo-merchant receipt, not a payment that happened. The page hashes with the same canonical JSON and SHA-256, in plain JavaScript, so it works without a wallet and without a build.

Leave "离线示例" checked. The page compares the hash to the sample hash baked into the file:

`sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`

That offline check does not contact NEAR. The same sample is already anchored on `sycee-anchor.testnet`: source chain `eip155:84532`, merchant id `sycee:demo-merchant`, block 277456711. Anchor transaction: [9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ](https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ). `scripts/verify.mjs` returned ok against that record. Uncheck "离线示例" and the page asks `sycee-anchor.testnet`, which is the default in the contract field. The public page URL is still `[待填]` (TBD). The owner enables GitHub Pages with source "GitHub Actions", then runs the `Demo page` workflow (`.github/workflows/near-anchor-pages.yml`). This repository does not turn Pages on. After that, the site is expected at `https://ruiruii.github.io/sycee/`. A demo video and an X post are also still `[待填]` (TBD).

## Build and test

From `examples/near-anchor` (Node 20 or newer; the sandbox test uses Node 22 in CI):

```bash
bash scripts/build.sh
npm install
npm test
cargo +1.100.0 test --manifest-path contract/Cargo.toml
```

`scripts/build.sh` compiles with Rust 1.86 (see `contract/rust-toolchain.toml`) and runs `wasm-opt --signext-lowering`. The near-sandbox bundled with `near-workspaces` is nearcore 2.6.2, which rejects newer Wasm proposals at prepare time. Rust 1.100 is used only for the host unit tests.

`npm test` covers the hash, the Merkle tree, the demo page, the deploy-script guards, and one local sandbox: anchor, duplicate rejection, unauthorized caller, missing-hash lookup, attached-deposit rejection, the event log, a batch whose root matches the JavaScript tree, `verify_inclusion`, and `scripts/verify.mjs` against that sandbox. It does not touch testnet.

The compiled file is `out/sycee_anchor.wasm`, 159146 bytes. It is not committed. Rebuild it.

These tests are not part of the root `npm test` matrix (Node 18, 20, and 22). A separate workflow, `.github/workflows/near-anchor.yml`, runs them.

## Deploy (testnet, your account)

Install [near-cli-rs](https://docs.near.org/tools/cli) and import the key of a testnet account you already have. Then:

```bash
cd examples/near-anchor
bash scripts/build.sh
NEAR_ACCOUNT_ID=your-account.testnet bash scripts/deploy.sh
```

`scripts/deploy.sh` refuses `NEAR_NETWORK` other than `testnet`, and refuses an account id ending in `.near`. It does not create an account. `sycee-anchor.testnet` is already deployed; run this only for another account you control.

Signing has two near-cli-rs modes. `NEAR_SIGN_WITH=auto` (the default) uses the OS keyring when a session exists, and otherwise the file keychain. A headless Linux box has no keyring, so auto picks the file.

| `NEAR_SIGN_WITH` | near-cli-rs flag | Where the key is |
|---|---|---|
| `keychain` | `sign-with-keychain` | The OS keyring. This fails on headless Linux with no session bus. |
| `legacy` | `sign-with-legacy-keychain` | `~/.near-credentials/testnet/<account>.json` |
| `auto` | one of the two above | Keyring if `DBUS_SESSION_BUS_ADDRESS` or the runtime bus socket is present (always on macOS); otherwise the file. |

The command it runs is:

```bash
near contract deploy "$NEAR_ACCOUNT_ID" \
  use-file out/sycee_anchor.wasm \
  with-init-call new \
  json-args "{\"owner\":\"$NEAR_ACCOUNT_ID\",\"anchorers\":[]}" \
  prepaid-gas '30 Tgas' \
  attached-deposit '0 NEAR' \
  network-config testnet \
  sign-with-keychain \
  send
```

On a machine with no OS keyring, the last signing word is `sign-with-legacy-keychain` instead of `sign-with-keychain`. The credentials file looks like `{"account_id":"...","public_key":"ed25519:...","private_key":"ed25519:..."}`. The script does not print that key.

Optional `NEAR_ANCHORERS` is a comma-separated list of extra writer accounts.

To anchor another receipt, set `NEAR_PRIVATE_KEY` or leave it unset and put the same JSON at `~/.near-credentials/$NEAR_NETWORK/$NEAR_ACCOUNT_ID.json`. `scripts/anchor.mjs` reads that file and does not print the key. A second copy of a hash the contract already stores is rejected. The sample hash above is one of those.

```bash
NEAR_ACCOUNT_ID=sycee-anchor.testnet \
NEAR_CONTRACT_ID=sycee-anchor.testnet \
  node scripts/anchor.mjs \
    --receipt path/to/receipt.json \
    --source-chain eip155:84532 \
    --merchant-id sycee:demo-merchant

NEAR_CONTRACT_ID=sycee-anchor.testnet \
  node scripts/verify.mjs --receipt fixtures/sample-receipt.json
```

`--evidence path/to/evidence.json` fills the chain and the payTo from the demo merchant's public page. It still needs the receipt file. The demo page's contract field already defaults to `sycee-anchor.testnet`.
