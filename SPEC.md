# SYCEE v0.1 — Agent Spend Semantics

> **Status:** Draft 0.1 · **License:** Apache-2.0 · **Date:** 2026-10-09
> **One-line:** We record. Others score.

---

## Abstract

Machine-to-machine payment protocols (x402, MPP, AP2, APOP, A2P2, card-A2A) have converged on a
stable answer to **"did the payment happen and did the seller send bytes?"** They have not
converged on — and in most cases do not define at all — the two questions that auditors,
enterprise buyers, and dispute resolvers actually ask:

| # | Question | Upstream status |
|---|----------|-----------------|
| Q1 | Was the resource delivered? | Defined by most receipt specs |
| Q2 | **Was the result consumed by downstream context?** | **Undefined everywhere** |
| Q3 | **How many times was the same payment proof redeemed?** | **Undefined everywhere** |

`SYCEE` defines a minimal, protocol-agnostic attribute set and a signed envelope
(**VSR**, Verifiable Spend Receipt) that answers Q2 and Q3 without answering anything else.

It is deliberately **not**:

- a payment protocol, wallet, or settlement rail;
- a reputation, credit, or trust score;
- a dispute arbiter or escrow agent;
- a custodian of payment proof bodies.

---

## 1. Introduction

### 1.1 The delivery/consumption gap

A pay-per-call agent flow has six observable events:

```
probe → 402 → pay → complete → deliver → ack
```

Existing instrumentation stops between `complete` and `deliver`. An HTTP `200` with a
well-formed body is recorded as success. But `200` is a statement about the **transport**, not
about the **outcome**. An agent may:

- pay for a search result and never place it in context (prompt budget exhausted);
- pay for a tool result that a downstream step discards as unusable;
- pay for the same resource twice because a retry lost the first response;
- redeem the same payment proof against three different resources.

All four are billed as successful spend. None is visible in any current receipt schema.

### 1.2 The one-proof-many-redemptions leak

x402's in-flight deduplication is designed to prevent **concurrent** replay of a
`payment_proof`. It does not, by design, prevent or record **sequential** reuse of the same
proof across separate requests or resources — the protocol permits multiple `complete`
transitions for one proof. `redeem_count` is introduced to make this observable rather than
to forbid it. `SYCEE` takes no position on whether multiple redemption is legitimate;
it asserts only that **it must be countable**.

### 1.3 Scope discipline

This spec adds fields; it does not redefine existing ones. Where a rail already defines
`delivery.status`, implementations SHOULD reuse the rail's value and MUST NOT assign a
conflicting meaning to `SYCEE` attributes.

---

## 2. Conformance language

The key words **MUST**, **MUST NOT**, **SHOULD**, **MAY** are to be interpreted as described
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 3. Terminology

| Term | Definition |
|------|------------|
| **resource** | A paid unit of access referenced by a stable `resource_id` (e.g. `search.v1`). |
| **payment proof** | The credential presented by the buyer at the `pay` step. Never stored by a conforming implementation. |
| **proof hash** | `H(payment proof)` — the only representation of the proof that may be persisted or signed. |
| **delivery** | The seller produced and transmitted the response bytes. |
| **consumption** | The buyer's runtime referenced the delivered result in downstream context. |
| **redemption** | A single `complete` transition accepted by a seller for a given `proof_hash`. |
| **VSR** | Verifiable Spend Receipt — the signed envelope defined in §6. |
| **signer** | The entity producing the signature. Either the seller (resource-side) or the buyer runtime (agent-side), or both. |

Notation:

- `H(x)` — SHA-256 digest of `x`, hex-encoded, prefixed `sha256:`.
- `ts` — ISO 8601 UTC timestamp, millisecond precision, `Z` suffix.
- `base64url` — URL-safe base64, no padding (RFC 4648 §5).

---

### 3.1 Payment-identity binding invariant (normative)

The payment identity — `agent.spend.request.fingerprint` and the `payment.proof_hash`
derived from it — MUST be bound to a request exactly **once**, at ingress, from the request
the buyer runtime actually received. This is the precise fix for the request-rebinding
attack: a seller re-describing the request after the fact so that settlement and refusal
bind to two different identities.

Two rules apply to every conforming implementation:

1. **One-shot derivation.** The fingerprint, and any downstream `attempt_id`, are computed a
   single time at ingress. No implementation step MAY re-read or re-derive the identity from
   the request, from `accepts[].resource.url`, or from any seller-supplied description of the
   request after ingress.
2. **Settle and refusal are lookups on one snapshot.** The settlement path **and** the
   `tx_already_used` / refusal path MUST resolve the *same* `attempt_id` from the single
   ingress snapshot. They are reads of one immutable record, never two independent parses.

For the x402 rail, the binding identity is composed over the client-received request as:

```
sha256( v1 | method | origin | path | query | payTo | asset | network | amount | scheme )
```

This invariant was converged with the operator of a production x402 v2 paid service
(StelarDigital / `x402-receipts`, issue #6) and is demonstrated as real-world vector RW-001
(§10.1). It generalizes the `request_fingerprint` defined in §5.1: the probe-step identifier
and the settlement-critical identity are one and the same snapshot.

---

## 4. The six-step event chain

| Step | Rail-agnostic name | What the spec records |
|------|--------------------|-----------------------|
| 1 | `probe` | `resource_id`, `request_fingerprint` |
| 2 | `challenge` | protocol, amount, currency |
| 3 | `pay` | `payment.proof_hash`, `payment.proof_seen_at` |
| 4 | `complete` | `payment.complete_seen_at`, `payment.redeem_count` |
| 5 | `deliver` | `delivery.status`, `delivery.delivered_at` |
| 6 | `consume` | `result.consumed`, `result.consumed_by`, `result.consumed_at`, `result.freshness_s` |

Steps 1–5 are observable by the seller. Step 6 is observable **only by the buyer runtime**.
This asymmetry is the reason a receipt is not sufficient evidence of consumption, and the
reason `SYCEE` requires bilateral instrumentation to reach conformance level 2 (§10).

---

## 5. Attribute registry

Attributes are emitted as OpenTelemetry span attributes on a span named
`agent.spend`. They are equally valid as plain JSON keys inside the VSR envelope.

### 5.1 Payment chain attributes

| Attribute | Type | Step | Definition |
|-----------|------|------|------------|
| `agent.spend.protocol` | string | — | `x402` \| `mpp` \| `ap2` \| `alipay-a2m` \| `apop` \| `a2p2` \| `card-a2a` \| `other` |
| `agent.spend.resource.id` | string | probe | Stable resource identifier assigned by the seller |
| `agent.spend.request.fingerprint` | string | probe | `H(method + " " + url + " " + canonical_query)` |
| `agent.spend.payment.proof_hash` | string | pay | `H(payment proof)`; **never the proof itself** |
| `agent.spend.payment.proof_seen_at` | timestamp | pay | Seller first observed the proof |
| `agent.spend.payment.complete_seen_at` | timestamp | complete | Seller accepted the proof |
| `agent.spend.payment.trade_no` | string | — | Rail-traceable transaction identifier |
| `agent.spend.payment.settlement_status` | enum | — | `settled` \| `in_flight` \| `absent` |
| `agent.spend.amount.value` | string | — | Decimal string (avoid float drift) |
| `agent.spend.amount.currency` | string | — | ISO 4217 (`CNY`, `USD`) or token symbol (`USDC`) |

> **Settlement predicate.** A payment's settlement state has one of three values; there is no
> fourth. `settled` means the transaction is confirmed enough for the rail. `in_flight`
> means the proof is known to have been broadcast or the transaction exists, but the seller
> cannot yet confirm finality (e.g., confirmations are below the threshold, the receipt is
> not readable yet, or `getBlockNumber` threw). `absent` means no transaction was found for
> the claimed proof.\n>
> The default for an unobserved state is `in_flight`, not `absent` — **\"not yet observable\"
> is not \"not settled\"**. This also keeps the predicate fail-closed: `in_flight` does not
> make the receipt valid, but a verifier can report \"unproven yet\" rather than \"refuted\".\n>
> `delivery.status` is orthogonal to `settlement_status`. `delivered` + `settled` is complete.
> `delivered` + `in_flight` is **incomplete**, not inconsistent — the bytes were produced
> before finality was known. `delivered` + `absent` is a **contradiction** a verifier MUST flag,
> because the seller claims to have produced bytes for a payment that never existed.
>
> A transport may use its own wire value (e.g., `X-Payment-Settled: true` / `queued` / absent)
> as long as it documents the mapping to the spec enum (`true → settled`, `queued → in_flight`,
> absent → `absent`).

### 5.2 Delivery attributes

| Attribute | Type | Definition |
|-----------|------|------------|
| `agent.spend.delivery.status` | enum | `delivered` \| `partial` \| `failed` \| `timeout` |
| `agent.spend.delivery.delivered_at` | timestamp | Response bytes produced |
| `agent.spend.delivery.bytes` | int | Response size in bytes (optional) |

### 5.3 Consumption attributes — **the missing semantics**

| Attribute | Type | Definition | Requirement |
|-----------|------|------------|-------------|
| `agent.spend.result.consumed` | enum | `yes` \| `no` \| `unknown` | **MUST** |
| `agent.spend.result.consumed_by` | string[] | Downstream `task_id` / `message_id` / `conversation_id` referencing the result | SHOULD |
| `agent.spend.result.consumed_at` | timestamp | First downstream reference | SHOULD |
| `agent.spend.result.freshness_s` | int | `consumed_at − delivered_at`, seconds | SHOULD |

**`consumed = yes`** — the buyer runtime can demonstrate that the delivered result was
referenced downstream: passed to another tool, inserted into a prompt, written into working
memory, persisted to a store, or surfaced to a human.

**`consumed = no`** — bytes were delivered and never referenced. This is *idle spend*: a real
cost with no downstream effect.

**`consumed = unknown`** — the buyer runtime did not instrument downstream context.
`unknown` MUST NOT be reported as `yes`, and MUST NOT be aggregated as `yes` by any
downstream consumer of the data.

> **Normative note.** An HTTP `200` response is `delivery.status = delivered`. It is never,
> by itself, `consumed = yes`.

> **Role constraint.** A VSR whose `signer.role = merchant` MUST set `result.consumed` to
> `unknown`. `consumed = yes | no` MUST be signed only by the `agent` role (the buyer runtime)
> or by an independent `observer` role that can demonstrate downstream reference. This prevents
> `consumed` from becoming a seller self-report.

### 5.4 Redemption attributes — **the missing semantics**

| Attribute | Type | Definition | Requirement |
|-----------|------|------------|-------------|
| `agent.spend.payment.redeem_count` | int | Count of `complete` events observed by the seller for this `proof_hash`, including replays, retries, and refusals | **MUST** |
| `agent.spend.payment.redeem_resources` | string[] | `resource_id`s against which the same `proof_hash` was presented | SHOULD |

`redeem_count = 1` is the ordinary case. `redeem_count > 1` means the seller saw the same
proof again — it may be a retry, a replay, or an attempted second redemption. The counter is
incremented **before** the seller decides whether to accept the payment, so a refused replay
is still recorded. Conforming implementations MUST record this and MUST NOT silently
normalize it to `1`.

### 5.5 Refusal attributes — **the missing half of the record**

§5.4 counts a proof presented again. It does not define what the seller says when it
declines that presentation. Without a refusal record, a buyer whose attempt was rejected
holds only its own account of the attempt, and "it paid / I refused" has nothing to
reconcile against.

A refusal record is **not** a receipt for a settlement. It is a signed statement about one
decision, and it carries three obligations.

#### 5.5.1 Every decision is recorded, default on

A conforming implementation MUST record one row per decision it makes about an attempt:
`accepted` or `refused`. Recording is the default, not an opt-in: an implementation that
records only accepted attempts MUST NOT claim conformance to this section.

| Attribute | Type | Definition | Requirement |
|-----------|------|------------|-------------|
| `agent.spend.refusal.decision` | enum | `accepted` \| `refused` | **MUST** |
| `agent.spend.refusal.reason` | enum | One of the closed reasons in §5.5.3; absent when `decision = accepted` | **MUST** when refused |
| `agent.spend.refusal.evidence_class` | enum | `issuer_asserted` \| `client_verifiable` \| `chain_verifiable` \| `independently_witnessed` | **MUST** when refused |
| `agent.spend.refusal.settlement` | enum | `not_submitted` \| `pending` \| `settled` \| `unknown` | **MUST** |
| `agent.spend.refusal.final` | bool | `false` whenever `settlement = pending` | **MUST** |
| `agent.spend.refusal.attempt_identity` | string | `sha256:<hex>` over the attempt, not over the payload alone (§5.5.4) | **MUST** |

#### 5.5.2 Evidence class is a ceiling, not a field

A signature proves **who signed**, never that the statement is true. A seller can sign a
false reason as easily as a true one. What this section constrains is not honesty but
**overclaiming**: a reason may not present itself as more provable than it is.

Each reason maps to the highest evidence class that is honest for it. A record MAY claim
that class or lower, and MUST NOT claim higher. An unrecognised reason closes at
`issuer_asserted`, the weakest class, so a reason nobody reviewed never sounds rigorous.

| `reason` | Highest honest `evidence_class` | Why |
|----------|-------------------------------|-----|
| `invalid_signature` | `client_verifiable` | the buyer holds the payload and can re-check it |
| `wrong_amount` | `client_verifiable` | price and authorization are both in the buyer's hands |
| `wrong_recipient` | `client_verifiable` | same |
| `malformed_payload` | `client_verifiable` | same |
| `authorization_expired` | `chain_verifiable` | the window is public |
| `authorization_not_yet_valid` | `chain_verifiable` | same |
| `insufficient_funds` | `chain_verifiable` | balance and transfer are public ledger state |
| `duplicate_payment` | `chain_verifiable` | the earlier settlement is public |
| `nonce_already_used` | `chain_verifiable` | the nonce is public |
| `facilitator_timeout` | `issuer_asserted` | only the seller saw the timeout |
| `risk_policy_rejected` | `issuer_asserted` | the policy is not disclosed |
| `commercial_refusal` | `issuer_asserted` | a business decision, with no technical cause |
| `internal_error` | `issuer_asserted` | a failure the seller cannot characterise |
| anything else | `issuer_asserted` | fail closed |

`independently_witnessed` exists in the enum and no reason in this version may point at it:
nothing here produces a witness.

#### 5.5.3 The two refusals are different facts

A comparison that could not be made is not a comparison that came out equal. The record
MUST distinguish:

- `could_not_compare` — a prior attempt for this proof exists, but its settlement state could
  not be read. Settlement claim: `unknown`.
- `replay_already_settled` — a prior attempt for this proof settled. Settlement claim:
  `settled`.
- `replay_in_flight` — a prior attempt is still unresolved. Settlement claim: `pending`,
  and `final` MUST be `false`.

Collapsing these into one reason erases the only information a buyer needs in order to tell
"my retry was legitimate and the seller's deduplication was wrong" from "my retry was a
duplicate and the seller was right".

#### 5.5.4 One payload is not one attempt

`attempt_identity` MUST be derived from a frozen ingress snapshot **and** from which
presentation this is. A settled attempt and its refused replay carry the same payload and
the same requirements, so any identifier derived from the payload alone resolves both to one
value — and the receipt for the refusal then cannot be tied to the replay rather than to the
original.

A verifier that holds the payload can recompute the identity and confirm the binding.

#### 5.5.5 Mutual contradiction

Two rows about the same `attempt_identity` MUST NOT disagree on `decision`. An
implementation that receives a second, contradictory decision MUST report the contradiction
and MUST NOT overwrite the first row. A replay refusal is not a contradiction: it concerns a
different `attempt_identity` (§5.5.4).

#### 5.5.6 The signing key is never the payee

`signer.public_key` MUST NOT be the address funds are paid to. One compromise must not both
authenticate records and move money, and a record identity that follows a payout rotation
cannot serve as a stable identity.

Where an implementation does not know the payee address at the time of the check, it MUST
report `not_measured`. Not measured is not passed.

#### 5.5.7 The portable claim

A row is server-internal. To be useful to a buyer it must be exportable as a claim the buyer
can hold and show to a third party without contacting the seller:

```json
{ "type": "x402-refusal-claim", "version": 1,
  "refusal": { "...": "the signed row" },
  "signature": "<ed25519 base64url over the canonical row>",
  "claim_id": "sha256:<hex of the canonical claim body>",
  "issued_at": "<ISO 8601>" }
```

A verifier MUST check: the signature against a key it resolves itself, never a key the
claim supplies; the evidence class against the ceiling (§5.5.2); the finality constraint
(§5.5.1); and the signing key against the payee where known (§5.5.6).

Reference implementation: `packages/core/src/refusal.mjs`, `refusalLedger()` in
`packages/middleware`, and `npm run demo:refusal`.

#### 5.5.8 What this does not cover

- A seller that never records anything. This section constrains the content of a record; it
  cannot make one appear.
- A buyer that never sent the request. A buyer-signed intent, sent before the attempt, is
  what would distinguish "refused a request I made" from "refused a request I never made".
  Not built here.
- A seller holding two contradictory claims about one attempt. Detecting that needs the
  buyer to hold both, and nothing guarantees it receives the second.

---

### 5.6 Completeness (informative)

| Attribute | Type | Definition |
|-----------|------|------------|
| `agent.spend.completeness` | enum | `bilateral` \| `unilateral_merchant` \| `unilateral_agent` |

`bilateral` — both seller and buyer runtime signed. This is the only state in which
`consumed` is attested rather than asserted.

---

## 6. VSR envelope

A VSR is a signed JSON document. It contains no request body, no response body, and no
payment proof body.

```json
{
  "vsr": {
    "schema_version": "sycee/v0.1",
    "protocol": "x402",
    "resource_id": "search.v1",
    "request_fingerprint": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "payment": {
      "proof_hash": "sha256:2c624232cdd221771294dfbb310aca000a0df6ac8b66b696d90ef06fdefb64a3",
      "redeem_count": 1,
      "redeem_resources": ["search.v1"],
      "proof_seen_at": "2026-10-09T12:00:00.000Z",
      "complete_seen_at": "2026-10-09T12:00:01.200Z",
      "trade_no": "202610091200010001"
    },
    "amount": { "value": "0.010000", "currency": "USDC" },
    "delivery": {
      "status": "delivered",
      "delivered_at": "2026-10-09T12:00:01.800Z",
      "bytes": 4821
    },
    "result": {
      "consumed": "yes",
      "consumed_by": ["task_4829"],
      "consumed_at": "2026-10-09T12:00:05.100Z",
      "freshness_s": 3
    },
    "signer": {
      "agent_id": "erc8004:8453:0x...",
      "public_key": "ed25519:...",
      "key_id": "2026Q4-01",
      "role": "merchant"
    }
  },
  "signature": "base64url(...)"
}
```

### 6.1 Field requirements

- `schema_version` MUST be `sycee/v0.1`.
- `payment.proof_hash` MUST be present. The raw proof MUST NOT appear anywhere in the envelope.
- `result.consumed` MUST be present and MUST be one of `yes` \| `no` \| `unknown`.
- `payment.redeem_count` MUST be present and MUST be an integer ≥ 1.
- `payment.settlement_status` SHOULD be present and MUST be one of `settled` \| `in_flight` \| `absent`.
  When the seller cannot determine the state, the value MUST be `in_flight` — **never** `absent`.
- `signer.role` MUST be `merchant` \| `agent` \| `observer`.
- `signature` MUST be a base64url-encoded Ed25519 signature over the canonical form of `vsr`.

### 6.1.1 Settlement / delivery cross-checks

`payment.settlement_status` and `delivery.status` are orthogonal. A verifier MUST evaluate
the pair, not either field alone:

| pair | verdict | meaning |
|------|---------|---------|
| `settled` + `delivered` / `partial` | `ok` | complete |
| `in_flight` + any | `incomplete` | bytes produced before finality was known |
| `absent` + `failed` / `timeout` / `partial` | `ok` | nothing settled, nothing (fully) served |
| `absent` + `delivered` | `contradiction` | **MUST be flagged**: bytes claimed for a payment with no transaction |
| `settled` + `failed` / `timeout` | warning only | paid without fulfilment — dispute material |

Fail-closed is preserved. `in_flight` does not make a receipt valid; it makes it
*unproven*. A verifier that requires settlement passes `requireSettled` and gets
`valid = false` with a reason distinguishable from `refuted`. A seller that knowingly
fulfils without payment sets `allowUnpaidDelivery` and downgrades the contradiction to a
warning — that is an explicit, auditable choice, not the default.

### 6.2 Signature scope

The signature covers the canonical JSON serialization (§7) of the `vsr` object.
The `signature` field is excluded. Request bodies, response bodies, and payment proof
bodies never participate.

---

## 7. Canonicalization and signing

### 7.1 Canonical JSON

Implementations MUST produce a byte-identical canonical form:

1. UTF-8 encoding, no whitespace.
2. Object keys sorted lexicographically by Unicode code point, recursively.
3. Array order preserved.
4. Numbers serialized per ECMAScript `Number::toString` (shortest round-trippable form).
   Monetary amounts SHOULD be strings to avoid representation drift.
5. No trailing newline.

This is consistent with [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785); a
conforming JCS implementation produces the same bytes.

### 7.2 Signing

```
Ed25519_sign(private_key, SHA-256? no — raw canonical bytes)
signature = Ed25519 over canonical_bytes(vsr)
```

Sign over the canonical bytes directly (Ed25519 performs its own internal hashing).

### 7.3 Verification

Given the VSR JSON and the signer's public key, any party can verify offline — without
contacting the seller, the buyer, the rail, or the spec author. Verification MUST:

1. re-canonicalize the `vsr` object;
2. verify the Ed25519 signature against `signer.public_key`;
3. confirm `schema_version` is understood;
4. confirm `result.consumed` ∈ {`yes`, `no`, `unknown`}.

### 7.4 Key management

- Key algorithm: Ed25519.
- Rotation interval: 90 days (RECOMMENDED).
- `signer.key_id` MUST be present when rotation is in use.
- Historical public keys MUST remain retrievable for at least 90 days past rotation.
- `signer.agent_id` SHOULD resolve to a legal-entity-stable identifier (e.g. ERC-8004
  `agentId`), never to a natural person.
- **Signing key ≠ payee address (MUST).** The key that signs a record MUST NOT be the
  address funds are paid to (§5.5.6). This is checked in code, not recommended in prose:
  `signingKeyCheck()` in `packages/core/src/refusal.mjs` returns `signing_key_is_payee` and
  the record is refused. Where the payee is unknown the result is `not_measured`, which is
  reported as such rather than as a pass.

---

## 8. Privacy

- **Data minimization.** Only hashes and timestamps are signed or stored. Bodies never are.
- **No personal data.** `agent_id` identifies an organization or agent registration.
- **Aggregation.** Any published statistic computed over VSRs MUST be k-anonymous with
  k ≥ 10, and MUST be computed over `consumed` / `redeem_count` counts only.
- **Retention.** Set by the deployer. 6–24 months is RECOMMENDED for compliance use.
- **Third-party red lines.** A conforming implementation MUST NOT store payment proof
  bodies, MUST NOT produce scores, and MUST NOT move funds.

---

## 9. Protocol mappings

| Rail | `protocol` | `trade_no` source | `proof_hash` source |
|------|-----------|-------------------|---------------------|
| x402 | `x402` | `payment_hash` / `tx_hash` | `H(PAYMENT-SIGNATURE header)` |
| MPP (Tempo) | `mpp` | Tempo tx hash | `H(payment credential)` |
| AP2 | `ap2` | Visa/FIDO trace id | `H(authorization)` |
| 支付宝 A2M | `alipay-a2m` | `trade_no` | `H(Payment-Proof)` |
| 银联 APOP | `apop` | APOP trace id | `H(payment credential)` |
| 京东 A2P2 | `a2p2` | ARI trace id | `H(payment credential)` |
| Card A2A | `card-a2a` | acquirer reference | `H(tokenized credential)` |

---

## 10. Conformance levels

### L0 — Minimal
- Emits `payment.proof_hash`, `delivery.status`, `result.consumed`, `payment.redeem_count`.
- Does not sign.
- Useful for internal telemetry only.

### L1 — Signed (unilateral)
- All L0 requirements.
- Produces a signed VSR from one side (`signer.role` = `merchant` **or** `agent`).
- `consumed` is *asserted* by the signing side; treat accordingly.

### L2 — Bilateral
- All L1 requirements.
- Two signatures present (merchant + agent), or one signature plus a co-signed
  `result` block.
- `completeness = bilateral`.
- This is the only level at which `consumed` is *attested* rather than asserted.

A conforming implementation MUST:

1. emit `payment.proof_hash` and never persist the raw proof;
2. emit `payment.redeem_count` for every `complete` event;
3. distinguish `consumed = yes | no | unknown`, never collapsing `unknown` into `yes`;
4. produce offline-verifiable Ed25519 signatures over the VSR envelope;
5. map `agent.spend.protocol` to a registered value;
6. confine vendor extensions to a `_vendor.*` namespace, never redefining core fields.

### Refusal rows

Refusal rows (§5.5) sit beside the levels above rather than inside them. A row is signed or
it is telemetry; there is no separate level. What §5.5 adds to a conforming implementation
is a MUST to record refusals at all, which no level previously required.

### 10.1 Real-world vectors

Synthetic vectors prove an implementation is self-consistent. They cannot prove the
semantics describe anything real. [`conformance/real-world/`](./conformance/real-world)
holds vectors built from actual settled payments, each with its provenance stated —
including when the payment was **not** a customer payment.

A real-world vector is accepted only after SYCEE re-verifies the payment
independently, against a public network, without trusting the submitter.

#### RW-001 — x402-receipts production origin (Base mainnet USDC)

- **Source:** `baianomarceloeduardo-jpg`, operator of `x402-receipts` (StelarDigital),
  comment on StelarDigital/x402-receipts#6, 2026-10-09. Full provenance in
  [`upstream/vector-x402-receipts-base.md`](./upstream/vector-x402-receipts-base.md).
- **Payment:** independently verified against a public Base RPC — block `51984731`, 0.02 USDC,
  EIP-3009 `transferWithAuthorization`. Their own paid self-test, not a customer payment.
- **Convergence:** this exchange independently reproduced the §3.1 payment-identity binding
  invariant — "one immutable snapshot at ingress… settle and refusal are lookups on it."
- **Known gap (stated honestly):** the origin's attestation ledger does not yet bind a
  settlement to an entry (`dataHash === sha256("{}")` at the attested index). RW-001 therefore
  demonstrates the gap between *evidence of signing* and *evidence of spend* — the exact gap
  `consumed` / `redeem_count` / `settlement_status` exist to close.
- **Credit:** the `tx_already_used` refusal as the counter-increment event, and the framing
  "prevention is a tourniquet; the count is the medical record," are quoted from
  `baianomarceloeduardo-jpg`'s own description of his origin, not from SYCEE code.

---

## 11. Relationship to adjacent specifications

| Spec / project | Defines | SYCEE adds |
|----------------|---------|-----------------|
| **x402-receipts** (npm, production) | Receipt format, request/response hash, delivery status, dual signature, EAS anchor | `consumed` / `consumed_by` / `redeem_count`; multi-rail, not chain-locked |
| **IETF draft-vauban-x402-*** | Receipt format, post-quantum signatures, Starknet anchoring, `action_ref` work binding | `consumed` / `redeem_count`; protocol-agnostic; no chain dependency |
| **ERC-8183** | On-chain escrow, evaluator verdict, task lifecycle | Off-chain, non-custodial consumption evidence; `redeem_count` |
| **VCAP / SwarmSync** | Escrowed settlement, delivery proof, reputation score | Non-escrow, non-scoring; `consumed` / `redeem_count` |
| **APASS / APOP** | Rail-native trust evidence | Cross-rail evidence; outcome semantics |
| **ERC-8004** | Agent identity and payment-proof schema | Reserved fields for `consumed` / `redeem_count` |

`SYCEE` is **additive** to all of the above. It is a candidate for upstream
contribution, not a competing standard.

---

## 12. Registry considerations (IANA)

Requested registrations under a future `agent.spend` namespace:

- `SYCEE` schema version registry (`v0.1`, …).
- `agent.spend.protocol` enumerated value registry.
- `agent.spend.delivery.status` enumerated value registry.
- `agent.spend.result.consumed` enumerated value registry (`yes` / `no` / `unknown`).

---

## Appendix A — Why `200` is not `consumed`

| Scenario | `delivery.status` | `result.consumed` | Economic meaning |
|----------|-------------------|-------------------|------------------|
| Agent pays, result used in next tool call | `delivered` | `yes` | Effective spend |
| Agent pays, result dropped (context full) | `delivered` | `no` | Idle spend |
| Agent pays, no instrumentation | `delivered` | `unknown` | Unmeasurable |
| Agent pays, seller times out | `timeout` | `no` | Waste |
| One proof, three `complete` events | `delivered` ×3 | varies | `redeem_count = 3` |

## Appendix B — Minimal end-to-end example

See [`conformance/vectors/`](./conformance/vectors) for machine-readable cases and
[`packages/`](./packages) for the reference implementation.

---

**Copyright 2026 SYCEE contributors. Licensed under Apache-2.0.**
