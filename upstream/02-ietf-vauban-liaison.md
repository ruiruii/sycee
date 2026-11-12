# Liaison: `consumed` / `redeem_count` as x402 receipt extensions

**To:** Vauban Research / IETF x402 community  
**From:** SYCEE contributors  
**Subject:** Field-level alignment between Vauban x402 receipts and SYCEE v0.1

## Context

Your drafts:

- `draft-vauban-x402-consolidated-00`
- `draft-vauban-x402-stark-receipts-02`

define a receipt format, post-quantum signatures, chain anchors, and an `action_ref`
field binding a receipt to a unit of work. They are, by our reading, the most advanced
x402 receipt standardization effort.

We are publishing `SYCEE v0.1` to define two semantic fields that the x402 / receipt
layer currently does not:

- `consumed` — was the delivered result referenced in downstream context?
- `redeem_count` — how many times was the same `payment_proof` accepted as `complete`?

We are **not** proposing a competing receipt format. We would like to see these fields
adopted as optional extensions to your draft, so that the ecosystem has one set of names
and one set of semantics.

## Why these fields fit your draft

Your `action_ref` binds a receipt to work. `consumed` answers a different question:
whether the **buyer runtime** actually referenced that work after delivery.

| Vauban field | Question | SYCEE complement |
|--------------|----------|----------------------|
| `payment_hash` / `tx_hash` | Which payment? | `proof_hash` (same idea, hash of proof) |
| `action_ref` | Which work unit? | `consumed_by` / `consumed_at` / `freshness_s` |
| `delivery.status` | Did the seller deliver? | `consumed` (did the buyer use it?) |
| (none today) | Was the proof reused? | `redeem_count` / `redeem_resources` |

## Proposed extension fields

In your receipt object, under a new optional block `outcome`:

```jsonc
{
  "outcome": {
    "consumed": "yes",           // yes | no | unknown
    "consumed_by": ["task_4829"],
    "consumed_at": "2026-10-09T12:00:05.100Z",
    "freshness_s": 3,
    "redeem_count": 1,
    "redeem_resources": ["search.v1"]
  }
}
```

The default for unsigned buyer context SHOULD be `consumed = unknown`. A conforming
implementation MUST NOT treat `unknown` as `yes`.

## Protocol-agnostic scope

While your drafts focus on x402, `consumed` / `redeem_count` are equally applicable to
MPP, AP2, APOP, A2P2, and card-A2A flows. We suggest the IETF draft defines these as
generic receipt extensions rather than x402-only fields.

## Reference materials

- Specification: `https://github.com/ruiruii/sycee/blob/main/SPEC.md`
- JSON Schema: `https://github.com/ruiruii/sycee/blob/main/schema/vsr-v0.1.schema.json`
- Conformance vectors: `https://github.com/ruiruii/sycee/tree/main/conformance/vectors`
- Reference implementation: Ed25519 offline verification in TypeScript/Node.

## Requested next step

A 30-minute alignment call before your draft expiry on **2026-11-29**.

Agenda:
1. Field-name consensus (`outcome` block vs `delivery` + `payment`).
2. Whether `consumed = unknown` default is acceptable for Vauban implementers.
3. How to keep SYCEE a non-competing complement.

---

**Contact:** sycee.rachel@gmail.com  
**License:** All text in this liaison is Apache-2.0.
