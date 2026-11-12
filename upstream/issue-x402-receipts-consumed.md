> **Name note.** This was sent when the project was called `gates-spec` (posted as [StelarDigital/x402-receipts#6](https://github.com/StelarDigital/x402-receipts/issues/6)). The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged.

Hi — first, credit where it's due: `x402-receipts` v0.5.1 is the most rigorous receipt spec in the x402 ecosystem. The §5 split of *delivery truth* vs *settlement truth* (and the explicit fail-closed enumeration) is exactly the kind of normative clarity this space needs. RFC 8785 JCS canonicalization, EAS batch anchoring, and the ERC-8183 binding are all things I'd rather build on than reinvent.

I'd like to propose **a third, independent predicate** — and two fields that go with it.

---

## The gap

§5 defines two truths:

| Truth | Question | Answered by |
|-------|----------|-------------|
| Settlement truth | Did the claimed payment actually happen on-chain? | `verifySettlement` |
| Delivery truth | Did the seller consider what they sent back a successful delivery? | `verifyReceipt` / `deliveryStatusOk` |

Both are **seller-observable**. Neither can answer:

1. **Did the buyer's runtime actually use the result?** (`consumed`)
2. **How many times was the same payment proof completed?** (`redeem_count`)

On (1): `delivery.status = "delivered"` is the seller's own claim about bytes they sent. An agent can pay, receive a valid response, and never place it in context — prompt budget exhausted, downstream step discarded it, retry superseded it. That is *idle spend*: real cost, zero downstream effect. Today it is indistinguishable from a genuinely used result.

On (2): x402's in-flight dedup prevents *concurrent* replay of a `payment_proof`, but the protocol permits multiple `complete` transitions for one proof. `redeem_count` makes sequential reuse countable rather than invisible. This is not hypothetical — see [brave/bx402#102](https://github.com/brave/bx402/issues/102) ("one payment buys N upstream calls").

## Proposed fields (additive, optional, backward compatible)

```jsonc
{
  "payment": {
    // ... existing fields
    "redeem_count": 1,                        // integer >= 1
    "redeem_resources": ["search.v1"]         // resource ids this proof was completed against
  },
  "delivery": {
    // ... existing fields
    "consumed": "unknown",                    // "yes" | "no" | "unknown"
    "consumed_by": ["task_4829"],             // downstream task_id / message_id / conversation_id
    "consumed_at": "2026-10-09T12:00:05.100Z",
    "freshness_s": 3                          // consumed_at - delivered_at, seconds
  }
}
```

Normative rules I'd suggest mirroring your §5 style:

- `consumed` absent → no claim made; MUST NOT be treated as `yes`.
- `consumed: "unknown"` → buyer runtime did not instrument downstream context. MUST NOT be aggregated as `yes`.
- `consumed: "no"` with `delivery.status: "delivered"` → valid receipt, but flags idle spend.
- `consumed: "yes"` SHOULD carry `consumed_by` evidence; assertion without evidence is weaker than attestation.
- `redeem_count > 1` MUST be recorded, never silently normalized to `1`.

**Who signs what.** `delivery.status` is signed by the seller (`seller.sig`). `consumed` can only be attested by the buyer runtime (`buyer.countersig` territory) — this is a natural fit for your existing dual-signature model: seller attests delivery, buyer attests consumption. When both are present over the same `receiptDigest`, the receipt is *bilateral*.

## Why propose this upstream instead of forking

I've published a protocol-agnostic spec covering these two fields — **gates-spec v0.1**: https://github.com/ruiruii/gates-spec

- `SPEC.md` + JSON Schema + Ed25519 reference impl (merchant middleware, agent SDK)
- 9 conformance vectors, CI green on Node 18/20/22
- Apache-2.0, zero dependencies

But a second, competing vocabulary helps nobody. If these fields land in `x402-receipts`, I'd rather **adopt your names and delete mine** than maintain a parallel schema. The goal is one set of names, not a new project.

Three concrete offers:

1. **A PR** adding the two fields as optional, with conformance vectors, if you tell me whether you'd rather see them inside `delivery`/`payment` or as a separate `outcome` block.
2. **Predicate text** for a §5 "consumption truth" subsection, drafted in your fail-closed style.
3. **A mapping** between EIP-712 (yours) and Ed25519 (mine) so implementations can cross-verify.

## Questions

- Do you prefer `delivery.consumed` / `payment.redeem_count`, or a separate `outcome` block?
- Any objection to `unknown` being the default when a buyer hasn't instrumented?
- Is `redeem_count` in scope for a receipt, or do you consider it a facilitator-level concern?

Happy to do the legwork on any of the three offers above. Thanks for the spec — it made this proposal much easier to write precisely.
