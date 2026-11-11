# Examples

Two ways in, depending on how much you want to read.

| File | What it shows | How to run |
|---|---|---|
| `walkthrough.mjs` | A server and a buyer in one process: 402, payment, a counted replay, both sides linking. | `node examples/walkthrough.mjs` |
| `minimal-server.mjs` + `minimal-client.mjs` | The same flow over real HTTP in two terminals, so you can poke it with `curl`. | see below |

Both need nothing beyond `npm install` — no network, no wallet, no accounts.

## `walkthrough.mjs` — start here

```bash
node examples/walkthrough.mjs
```

Six short sections, each printing what happened. It ends with both receipts
verifying offline and linking to each other.

The proof string is a placeholder; SYCEE only ever handles `sha256(proof)`, so
the example never needs a real payment credential.

## `minimal-server.mjs` and `minimal-client.mjs`

Two terminals:

```bash
node examples/minimal-server.mjs
```

```bash
node examples/minimal-client.mjs
```

The server listens on `http://localhost:4000` and exposes:

- `GET /paid` — returns `402 Payment Required` without a `payment-signature` header.
- `GET /paid` with `payment-signature: <anything>` — returns the response plus an
  `x-gates-receipt` header and an `x-gates-redeem-count` header.

You can also drive it by hand:

```bash
curl -i http://localhost:4000/paid
curl -i -H 'payment-signature: demo-proof-1234' http://localhost:4000/paid   # redeem_count: 1
curl -i -H 'payment-signature: demo-proof-1234' http://localhost:4000/paid   # redeem_count: 2
```

The client intentionally pays twice with the **same** proof: `redeem_count = 1`
on the first call, `2` on the second. This is the "one proof, multiple
redemptions" gap made visible.

The merchant receipt always carries `result.consumed = "unknown"` — the seller has no
observation of the buyer's runtime, and per SPEC §5.3 a merchant-signed VSR MUST NOT
assert consumption. The buyer attests it separately (see `minimal-client.mjs`, which
calls `gates.consumedBy(task_id)` and signs an agent-side VSR); `linkReceipts()` binds
the two sides into `completeness = bilateral`.

## What to look for

1. The response body does **not** contain the raw payment proof.
2. The receipt header contains only hashes and signatures.
3. The agent runtime is the side that sets `consumed = yes`, not the merchant.

## A note on header names

The wire headers are `x-gates-*` and the challenge body carries `gates_spec`. Those
are transport-level names kept for compatibility with already-integrated callers; the
packages are `@sycee/*`. If you write your own client, read the header names off the
response rather than hard-coding them.
