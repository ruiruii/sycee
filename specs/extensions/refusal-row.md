# Refusal Row Extension

> **Status:** Draft · **Depends on:** nothing outside this extension · **Companion to:** §5.5 of
> the settlement/refusal identity proposal

## 1. Summary

When a resource server declines a payment attempt, the buyer is left holding nothing it can
point at. The 402 response is gone as soon as it is read. Even where a transport carries a
plain-language reason, that reason lives for one response cycle and is signed by nobody.

This extension adds the missing statement: **one recorded row per decision, refusals
included, with a bounded reason and an evidence class the row cannot exceed.** A row is
server-internal by default and exportable as a claim the buyer can carry.

It is deliberately small. It does not define a payment scheme, does not change settlement or
verification semantics, does not add a discovery layer, and does not give a seller an
incentive to write honest rows. It gives a seller a place to write rows and a buyer something
to check.

## 2. What this is not

Stated first, because a bounded scope is easier to check than a claim of completeness.

- **Not a receipt for a settlement.** It says nothing about whether funds moved, except for
  the one settlement value it reports about itself.
- **Not a proof that the reason is true.** A signature proves who signed. Nothing more.
- **Not a witness.** No transparency log, no third party. `independently_witnessed` exists in
  the enum; no reason in this version may claim it.
- **Not a cure for silence.** A seller that records nothing cannot be caught by any format.

Two gaps worth naming, both real:

1. A buyer never sends the request it claims was refused. Without a buyer-signed intent sent
   before the attempt, "refused a request I made" and "refused a request I never made" are
   indistinguishable. Not built here.
2. Detecting two contradictory claims about one attempt requires the buyer to hold both.
   Nothing guarantees it receives the second.

## 3. Relationship to adjacent work

- **§5.5 of the settlement/refusal identity proposal.** That section defines when two paths
  must resolve to the same `attempt_identity`, and it keeps three identifiers apart —
  operation identity, captured-artifact digest, signed-content identifier. This extension
  consumes the first: `attempt_identity` here is the operation identity, derived from a
  frozen ingress snapshot **and** from which presentation this is (§3.3). It does not
  redefine, narrow or extend that invariant.

  The distinction matters for a concrete case. One signed payload presented twice — accepted
  and settled, then declined as `duplicate_payment` — carries one payload, one set of
  requirements, and two attempts. An identifier derived from the payload alone resolves both
  to a single value, and the row for the refusal then binds to "this payload was refused"
  rather than "this presentation was refused after that one settled". The second statement is
  the one a buyer can reconcile against its own ledgers.

- **A signed rejection artifact, proposer-side.** A format that issues a signed document at
  refusal time is complementary and could be derived from these rows. This extension does not
  define such a document; it defines what gets recorded and what a recorded row may claim.

- **Plain-text 402 error bodies.** Useful, ephemeral, unsigned. Not a record.

## 4. Row structure

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | Yes | `sycee/refusal/v0.1` |
| `decision` | string | Yes | `accepted` or `refused` |
| `reason` | string | When refused | One of the closed set in §5 |
| `reason_detail` | string | When refused | The fixed sentence for that reason |
| `evidence_class` | string | When refused | `issuer_asserted`, `client_verifiable`, `chain_verifiable`, `independently_witnessed` |
| `attempt_identity` | string | Yes | `sha256:<64 hex>`, derived per §3 |
| `settlement` | string | Yes | `not_submitted`, `pending`, `settled`, `unknown` |
| `final` | boolean | Yes | MUST be `false` when `settlement` is `pending` |
| `proof_hash` | string | No | Hash of the presented proof. The proof itself is never stored |
| `resource_id` | string | Yes | What was requested |
| `protocol` | string | Yes | Transport the attempt arrived on |
| `observed_at` | string | Yes | ISO 8601 |
| `signer.public_key` | string | Yes | `ed25519:<base64url>` |
| `signer.role` | string | Yes | `merchant` or `agent` |
| `key_check` | string | Yes | `distinct`, or `not_measured` when the payee is unknown |

`key_check` records what the implementation was able to check about its own signing key,
rather than implying it checked. A verifier that knows the payee re-checks it independently.

## 5. The closed reason set

A reason is not free text. Free text cannot be compared across sellers, cannot be bounded by
an evidence class, and drifts into marketing.

| `reason` | Ceiling | Meaning |
|---|---|---|
| `invalid_signature` | `client_verifiable` | the payload's authorization signature does not verify |
| `wrong_amount` | `client_verifiable` | authorized amount ≠ price |
| `wrong_recipient` | `client_verifiable` | authorized recipient ≠ this merchant |
| `malformed_payload` | `client_verifiable` | the payload could not be decoded |
| `authorization_expired` | `chain_verifiable` | the authorization window has closed |
| `authorization_not_yet_valid` | `chain_verifiable` | the window has not opened |
| `insufficient_funds` | `chain_verifiable` | balance does not cover the authorized amount |
| `duplicate_payment` | `chain_verifiable` | the proof was already settled |
| `nonce_already_used` | `chain_verifiable` | the authorization nonce is consumed |
| `facilitator_timeout` | `issuer_asserted` | the facilitator did not answer in budget |
| `risk_policy_rejected` | `issuer_asserted` | declined by an undisclosed policy |
| `commercial_refusal` | `issuer_asserted` | declined on business grounds, no technical cause |
| `internal_error` | `issuer_asserted` | the seller failed and is not claiming a cause |
| anything else | `issuer_asserted` | fail closed: an unreviewed reason never sounds rigorous |

Six reasons also exist to describe a repeat presentation, and they are not the same fact:

| `reason` | Settlement claimed | Meaning |
|---|---|---|
| `replay_already_settled` | `settled` | a prior presentation of this proof settled |
| `replay_in_flight` | `pending`, `final = false` | a prior presentation is unresolved |
| `could_not_compare` | `unknown` | a prior row exists, its settlement state was unreadable |

**A comparison that did not happen is not a comparison that came out equal.** Collapsing
`could_not_compare` into `replay_already_settled` tells a buyer its retry was a duplicate
when the seller in fact could not tell. Collapsing it into `accepted` tells a buyer nothing
at all.

## 6. Verification

A verifier of a single row, or of a claim carrying one, checks:

1. `decision` is one of the two values.
2. When refused, `reason` is in the closed set. An unknown reason means the row was not
   produced by a conforming implementation; the row is not silently reinterpreted.
3. `evidence_class` does not exceed the ceiling for its reason.
4. `settlement` is one of the four values; `final` is `false` whenever `settlement` is
   `pending`.
5. The signature verifies against a key the verifier resolves itself — never against a key
   the row supplies.
6. `signer.public_key` is not the payee address, where the verifier knows the payee. Where it
   does not, the result is `not_measured`, reported as such.

Two rows about one `attempt_identity` that disagree on `decision` are a contradiction. An
implementation reports it and keeps both; it does not overwrite.

## 7. The portable claim

A row is internal. A claim is what a buyer carries away:

```json
{
  "type": "x402-refusal-claim",
  "version": 1,
  "refusal": { "...": "the signed row" },
  "signature": "<ed25519 base64url over the RFC 8785 canonical row>",
  "claim_id": "sha256:<hex of the canonical claim body>",
  "issued_at": "2026-11-11T08:04:28.000Z"
}
```

Claims are checked with §6. Nothing about a claim depends on contacting the seller.

## 8. Key separation

`signer.public_key` MUST NOT be the address funds are paid to.

Two reasons, and the second is the one that matters for this specification: one compromise
should not both authenticate records and move money, and a record identity that rotates with
a payout address cannot be a stable identity for the merchant across years. §7.4 of the base
specification already recommends separation for the payment key; this extension makes it a
checked rule, in code, with a distinguishable result when the check cannot run.

## 9. Reference implementation

`sycee` (Apache-2.0), no network, no wallet:

- `packages/core/src/refusal.mjs` — ceilings, row construction, claim export and
  verification, as pure functions.
- `packages/middleware` — `refusalLedger()`, and a resource handler that records on both the
  accepted and the refused path.
- `npm run demo:refusal` — five attempts, one ledger, four claims verified offline, and the
  two things a claim is not allowed to do.

Test coverage as of this draft: 42 tests over the core rules and 21 over the handler
behaviour, including the overclaim, the pending-finality, the key/payee collision and the
contradiction cases.

## 10. Known limitations

- Silence is not covered (§2).
- No buyer-signed intent (§2).
- No witness mode; `independently_witnessed` is unreachable by construction (§2).
- The reason table is this extension's own. If a transport later publishes its own refusal
  codes, this table maps onto that list; it does not claim to be that list.
- `reason_detail` is a fixed sentence per reason, not a message from the seller. A seller
  that wants to say more can attach a `_vendor` field; nothing in a `_vendor` field is
  covered by the evidence ceiling.
- **A row cannot answer the question the buyer is actually asking.** When a `/settle`
  call is lost in flight, the buyer's question is "did the money move?", and no facilitator
  surface answers it: the surface is `/supported`, `/verify`, `/settle`, with no read
  endpoint keyed by the payment authorization (nonce, or the EIP-3009 authorization hash),
  and `/settle` is an execution call rather than a query. A row here evidences that an
  attempt happened and how it was decided; it does not evidence that funds moved.
- **Under `exact` the chain does answer it, and that makes the gap smaller than it looks.**
  `authorizationState(authorizer, nonce)` is a view call any third party can make on an
  EIP-3009 token, and it returns true only after the transfer executed. So "did the money
  move" is not unknowable — it is unaddressable: a buyer who lost the response also lost the
  `(authorizer, nonce)` pair needed to ask, because the answer lives in a payload that was
  never persisted on their side. The missing piece is therefore the payload's durability
  before broadcast, not a new facilitator endpoint, and an implementation that keeps the
  signed payload can re-derive the pair and ask the chain directly. That is the same
  requirement x402#4198's seller-side claim is stated over, which is why it is phrased over
  the payload rather than over an endpoint. Schemes without an equivalent read keep the
  wider claim: for them there is nothing to ask, and the gap is a protocol one.
- **One attempt can leave two rows and a wrong claim.** §4's ceiling forbids a row from
  claiming more evidence than its reason allows, but an issuer can get the same effect by
  recording one attempt twice: once with the true, low-ceiling reason, and once with a reason
  whose ceiling is higher but which is not true. Each row is internally consistent, so §6's
  checks all pass on both; and because the two presentations of one payload carry different
  `attempt_identity` values (§5.5.4 of the companion spec), the contradiction rule — which
  compares `decision` within one identity — never fires either. A reader who holds both is
  free to quote the flattering one. Bounding what one row may say does not bound what two
  rows may say together, and nothing in this version detects it. See §12 for
  why no fix belongs in this section.

## 11. Reference: the collision this document's binding must avoid

`attempt_binding` here is a digest of the payment payload and the requirements. If a future
revision adds an ordinal — the price a content-addressed binding cannot tell a settled
attempt from its refused replay — the field must go into a canonical object, not be appended
to a string before hashing:

```js
sha256(payload + String(n))                        // wrong: ('A:1', 2) and ('A:', 12) collide
sha256(canonicalJSON({ payload: sha256(payload),
                       requirements: sha256(req),
                       presentation: String(n) })) // right: the fields cannot be spliced
```

The first line is not hypothetical. `packages/core/test/refusal.test.mjs` pins the collision
and the fix side by side, because the easy way to add an ordinal is the one that breaks the
property the ordinal was added for.

## 12. Why the surviving hole is not fixed here

Section 10 names a hole: an issuer can say something worse than the ceiling allows by saying
it twice rather than by over-claiming once. The obvious fix is to compare rows sharing an
`attempt_binding` and require them to agree. That fix cannot live in this document, and the
reason is worth stating rather than hiding behind scope:

- **Rows about one payload are legitimately plural.** Each presentation of a payload is its
  own attempt with its own reason; a first submission refused for `insufficient_funds` and a
  retry refused for `facilitator_timeout` are two rows and neither is wrong. Requiring
  agreement across them would either forbid that or force one row per payload, which is the
  collapse this extension exists to prevent. The attack lives precisely in that gap: it needs
  rows that are allowed to differ, and supplies a reason that is not true as one of them.
- **The comparison is between issuers, not inside one.** The attack needs two documents, and
  the second is only persuasive because it is signed by the same issuer — but durably
  recording that "these two were issued and they disagree" needs a substrate that outlives
  the issuer's own database, which is a transparency log.
- **A local check would be a false comfort.** An implementation comparing rows it happens to
  hold would pass the check while the attack is entirely outside its view.

So the honest statement is the one in §10: a bounded reason set bounds one row, and this
version does not bound a set of rows. A verifier holding two rows for one attempt should
prefer the lower-ceiling reason when it has no independent way to tell which is true — that
is a reader's rule, not a format requirement, and it is offered as advice, not as a check.

## 13. Crosswalk: the four loser branches of x402#4198

x402's [#4198](https://github.com/x402-foundation/x402/issues/4198) pre-registers a
claim-race battery against a caller-supplied idempotency key. Its H2 row was amended before
freeze (comment of 2026-11-11T15:22:32Z) from a two-valued loser observation to a
registered range of four, pinned to `claimIdempotentPurchase()` / `beginVerifiedPurchaseIntent()`
at commit `56d6db340505dec2fec9d89780a498ff9ba37bfb`. Those four are the only public
enumeration of "what a duplicate looks like from the seller's side" that does not assume the
answer is binary, which makes them worth mapping against §5 rather than leaving to a thread.

This is a mapping, not an endorsement, and not evidence that anything here has been adopted.
The battery runs an offline re-implementation with settlement mocked and carries the
platform's single-writer guarantee as a pinned assumption; its verdicts are self-attested
and scoped to that boundary.

| #4198 loser branch | prior record state | Output here | Same decision? |
|---|---|---|---|
| `Original purchase admission pending` | prior claimed, not yet persisted | `could_not_compare` (`unknown`) | yes — refused |
| `settlement_unknown` | prior persisted, state unreadable | `could_not_compare` (`unknown`) | yes — refused |
| `purchase_recovery_pending` | prior settled, recovery in progress | `replay_already_settled` (`settled`) | yes — refused, different follow-up |
| `purchase_not_settled` | prior persisted, not settled | `accepted` (`not_submitted`) | no — different question |

Three things this table costs us to admit:

- **The first two branches share one code here, deliberately.** §5 requires that a
  comparison that did not happen not be reported as one that came out equal; it does not
  require the format to say *why* it did not happen. A reader that needs the distinction —
  wait for admission, versus go query settlement — reads it from the seller's own status
  surface, not from the reason code.
- **Branch 3 matches a decision, not an action.** `replay_already_settled` tells a buyer its
  proof already settled; `purchase_recovery_pending` tells it a recovery is underway and
  where to look. Same refusal, different instruction, and a seller adopting this extension
  still has to choose the instruction.
- **Branch 4 is not the same question.** #4198's loser is the second of two *concurrent*
  signatures under one key; `accepted` here means the earlier presentation never reached the
  rail, so this one is not a replay — a claim about a *sequence*, not about a *window*. The
  two do not conflict, and neither covers the other: a seller that adopts this extension
  still needs its own rule for the concurrent case, which is exactly what #4198 proposes to
  put in the claim layer.

The reason this is written down rather than left in a thread: a reader holding both documents
will otherwise conclude that four branches contradict three codes. They do not. The first
three are a coarser answer to the same question; the fourth is a different question. Which of
the four a tightly-raced loser actually lands in is registered there as timing-sensitive
behaviour — this table maps the range, not an observed run.

One neighbouring implementation handles the same shape differently, and the difference is
worth recording because it points at a fix §12 does not consider. vet402's observatory keeps
a daily hash chain over its purchase ledger and, separately, a corrections log whose rows are
"added and not rewritten": a correction cites the row it corrects by id, carries the SHA-256
of that row as it read when the correction was filed, and — when filed by a third party —
carries its own signature, re-verified on every read (schema as of 2026-11-13,
`GET /api/v1/observatory/ledger-corrections`). Filing a correction leaves the cited row as it
is.

It does not forbid the second row. It makes the relation between the two rows explicit and
checkable. That is the shape a fix would take here too: not "these two rows must agree" —
which §12 rejects, because rows about one payload are legitimately plural — but "a row that
corrects another names it, and names what it read", which leaves both rows legitimate while
making the pair auditable by anyone holding them. It does not close the hole: an issuer can
still file a correction-shaped row that is not true. What it removes is the property that
makes the hole cheap — that the second row is indistinguishable from an independent
observation of the same attempt.

## 14. Triage: which layer answers "what happened to my payment"

The question §10 records arrived in public as one question and left as four answers, none of
which disagreed. That is a symptom worth writing down. In the x402 Slack thread of 2026-11-14
on a lost `/settle` response, three participants answered the same complaint, each answer
correct inside its own layer; the grouping below is the asker's own summary of what each
answer was good for, kept because it is more useful than a claim that the problem is unsolved.

| Question | Only reliable source | Shape of the answer | What it cannot tell you |
|---|---|---|---|
| Did the money move? | The token contract, via `authorizationState(authorizer, nonce)` on EIP-3009 | A boolean anyone can read, true only after the transfer executed | Whether *this* attempt is the one that moved it — that needs the pair below |
| Which attempt was it? | The payload the caller signed and kept | `(authorizer, nonce)`, or the equivalent stable id the scheme provides | Whether the seller decided anything about it |
| How was it decided? | The seller, in a row | A reason (§5) bound to one attempt identity (§4) | Whether funds moved (§10) |
| Did two concurrent attempts both settle? | The seller's claim layer | A claim taken before broadcast, so the loser is refused | Anything about attempts it never saw |
| How long does idempotency survive a restart? | Whoever operates the facilitator | Vendor documentation or SLA | Nothing about the protocol — the protocol does not require it |

Two consequences follow, and both are cheap to act on now.

**The first two rows are the caller's own responsibility, and they are the only ones a caller
can satisfy alone.** A payload persisted before broadcast yields the `(authorizer, nonce)`
pair; the pair yields a chain read. That is a complete answer to "did my payment go through"
with no facilitator cooperation, no protocol change, and no trust in the seller. The failure
mode it prevents is not a missing endpoint — it is a process that writes to the network
before it writes to disk.

**Answers from different rows do not compose.** The recurring error in this thread was to
assemble one recovery story out of four correct answers, which produces a plan that inherits
every gap instead of closing one. A row evidences a decision; a chain read evidences a
transfer; neither substitutes for the other, and a design that treats them as interchangeable
will report settlement it cannot prove. This is the same boundary §10 draws, stated from the
reader's side rather than the format's.

