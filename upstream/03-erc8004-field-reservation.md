# ERC-8004 v2 field reservation request: `consumed` / `redeem_count`

**To:** ERC-8004 authors / agent identity standard maintainers  
**From:** SYCEE contributors  
**Subject:** Reserve two fields in the ERC-8004 v2 payment-proof / agent-identity schema

## Background

ERC-8004 defines a stable agent identifier and a payment-proof schema. As agent payments
move from proof-of-concept to production, two questions are becoming urgent:

1. Did the agent actually **consume** the result it paid for?
2. How many times was the same payment proof **redeemed**?

Neither is a scoring or reputation question. Both are **protocol facts** that can be
recorded without storing raw payment proof bodies.

## Requested reservation

Reserve the following two field names in the ERC-8004 v2 payment-proof / spend-event schema:

| Field | Type | Semantics |
|-------|------|-----------|
| `agent.spend.result.consumed` | enum `yes` / `no` / `unknown` | Whether the delivered result was referenced by downstream context. |
| `agent.spend.payment.redeem_count` | integer ≥ 1 | Number of distinct `complete` events accepted for the same `proof_hash`. |

Optional companions:

- `agent.spend.result.consumed_by` — `string[]` of `task_id` / `message_id` / `conversation_id`
- `agent.spend.result.consumed_at` — ISO-8601 timestamp
- `agent.spend.result.freshness_s` — seconds between delivery and first consumption
- `agent.spend.payment.redeem_resources` — `string[]` of `resource_id`s

## Rationale

ERC-8004 is likely to become the canonical place where an agent records its payment
history. If the schema does not reserve these names now, the ecosystem will fragment
(e.g. `used`, `utilized`, `spent`, `redemption_count`, `reuse_count`).

By reserving the names early, ERC-8004 v2 can:

- remain neutral (no scoring, no fund movement);
- interoperate with x402-receipts, Vauban IETF drafts, and SYCEE;
- give wallet implementers one attribute namespace to instrument.

## Proposed OTel mapping

These fields are emitted as OpenTelemetry span attributes on a span named
`agent.spend`. They are also valid inside the SYCEE VSR envelope.

```json
{
  "agent.spend.result.consumed": "yes",
  "agent.spend.result.consumed_by": ["task_4829"],
  "agent.spend.result.consumed_at": "2026-10-09T12:00:05.100Z",
  "agent.spend.result.freshness_s": 3,
  "agent.spend.payment.redeem_count": 1,
  "agent.spend.payment.redeem_resources": ["search.v1"]
}
```

## Non-scope

These fields do **not**:

- Replace ERC-8004 agent identity.
- Add an on-chain evaluator or escrow.
- Define a reputation score.
- Move funds.

## Offer

We will provide a reference mapping between ERC-8004 v2 and SYCEE v0.1, plus
test vectors, if the reservation is accepted.

---

**License:** Apache-2.0.
