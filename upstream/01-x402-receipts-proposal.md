# Proposal: extend x402-receipts with `consumed` / `redeem_count`

**To:** maintainers of `x402-receipts` (stelardigital)  
**From:** SYCEE contributors  
**Subject:** Upstream alignment — two semantic fields your schema currently omits

## Summary

`x402-receipts` is the most mature receipt implementation in the x402 ecosystem. It already
covers delivery proof, request/response binding, and dual signatures. We would like to
propose two optional extensions that sit **beside** your existing schema, not on top of it:

| Field | Location in your schema | Semantics | Why it matters |
|-------|------------------------|-----------|----------------|
| `consumed` | `delivery` or a new `result` block | `yes` / `no` / `unknown` — was the delivered result referenced downstream? | HTTP 200 is delivery, not usage. |
| `redeem_count` | `payment` | Number of times the same `payment_proof` was accepted as `complete` | x402 permits multiple `complete` calls per proof. |

## Why this is additive

Your current schema records:

- `url_hash`, `params_hash`, `body_sha256` → what was requested
- `payment_hash` → which payment occurred
- `timestamp` → when delivery happened
- `goods` → what was delivered
- `delivery.status` → did the seller deliver

Missing:

- Did the agent **actually use** the delivered result?
- Was the same `payment_hash` completed more than once?

We believe both are natural extensions of the existing `x402-receipts` `goods` / `delivery.status`
model and should live in the same signed receipt.

## Proposed schema diff

```json
{
  "goods": { ... },
  "delivery": {
    "status": "delivered",
    "delivered_at": "2026-10-09T12:00:01.800Z",
    "consumed": "yes",
    "consumed_by": ["task_4829"],
    "consumed_at": "2026-10-09T12:00:05.100Z"
  },
  "payment": {
    "payment_hash": "0x...",
    "redeem_count": 1,
    "redeem_resources": ["search.v1"]
  }
}
```

## Evidence

- **Brave / brave/bx402#102** reports "one payment buys N upstream calls" — the same proof is
  replayed to multiple searches.
- **minia2a** reported 25% credit utilization: agents buy credits but do not consume them.
- **x402-foundation/x402#1195** explicitly states: the payment layer does not prove delivery,
  let alone consumption.

## Offer

We have a reference implementation and conformance vectors at
`https://github.com/ruiruii/sycee`. We are happy to submit a PR that:

1. Adds `consumed` / `consumed_by` / `consumed_at` / `freshness_s` to the `delivery` block.
2. Adds `redeem_count` / `redeem_resources` to the `payment` block.
3. Keeps both optional and backward-compatible.
4. Includes conformance test vectors.

The long-term goal is **not to fork** the receipt format, but to make sure these two
semantic fields have the same names across x402-receipts, SYCEE, and any future
IETF draft.

---

**Please reply with:**
- Whether you prefer these fields inside `delivery`/`payment` or as a separate `result` block.
- Any concerns about the `consumed = unknown` default.
