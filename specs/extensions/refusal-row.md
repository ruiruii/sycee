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
  frozen ingress snapshot **and** from which presentation this is (the recipe in §4). It does not
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

- **§5.5's countersignature obligation, and why this extension refuses to meet it.** §5.5 now
  requires that a counterparty that countersigns recompute the fingerprint **from the bytes it
  observed**, and that where it cannot, it refuse and say which failure it is — values differ,
  or the comparison could not be made. A row here MUST NOT be offered as that countersignature.
  The decisive reason is not taste, it is arithmetic: a row records a `decision`, and at
  refusal time the seller holds no observed settlement outcome to recompute anything from. The
  only attempt at compliance would be to fill an absent observation with a default — `not
  settled` for a settle that has not returned — and §5's fixed reason set exists in part to
  make that filling visible rather than silent. So the honest answer is the one §5.5 itself
  provides for: *could not be compared*, stated as such. If a seller adopts both documents, the
  row is the record and something else is the countersignature; a row that claims both is
  claiming an observation it did not make.

  The gap that opens here is worth stating plainly, because it is the shape of the whole
  problem. A resource server that is the only party holding the paid request cannot normally
  *prove* it observed that request: it can produce a signature, not a byte range. The
  correction in x402#3776 `8dcbba3` therefore fixes where the countersignature may come from
  — the resource server or the payer, never the facilitator, whose `/verify` and `/settle`
  calls carry no `method`, `path`, `query`, or `body` — but it does not yet say what makes that
  party's claim checkable by a third party. Until it does, this extension can say what was
  decided and who said so; it cannot say that anyone observed it.

## 4. Row structure

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | Yes | `sycee/refusal/v0.1` |
| `decision` | string | Yes | `accepted` or `refused` |
| `reason` | string | When refused | One of the closed set in §5 |
| `reason_detail` | string | When refused | The fixed sentence for that reason |
| `evidence_class` | string | When refused | `issuer_asserted`, `client_verifiable`, `chain_verifiable`, `independently_witnessed` |
| `attempt_identity` | string | Yes | `sha256:<64 hex>`, derived per the recipe below |
| `settlement` | string | Yes | `not_submitted`, `pending`, `settled`, `unknown` |
| `final` | boolean | Yes | MUST be `false` when `settlement` is `pending` |
| `proof_hash` | string | No | Hash of the presented proof. The proof itself is never stored |
| `legs` | object | No | `{ authorization, transfer }` as observed. See §15.4. Absent means nothing was observed, not that both failed |
| `resource_id` | string | Yes | What was requested |
| `protocol` | string | Yes | Transport the attempt arrived on |
| `observed_at` | string | Yes | ISO 8601 |
| `signer.public_key` | string | Yes | `ed25519:<base64url>` |
| `signer.role` | string | Yes | `merchant` or `agent` |
| `key_check` | string | Yes | `distinct`, or `not_measured` when the payee is unknown |

`key_check` records what the implementation was able to check about its own signing key,
rather than implying it checked. A verifier that knows the payee re-checks it independently.

`attempt_identity` is derived once, from what the attempt presented, never from the payload
alone. The recipe:

```
attempt_identity = sha256( canonicalJSON({
    spec:          "sycee/refusal/v0.1",
    payload:       sha256(payload),
    requirements:  sha256(requirements),
    presentation:  String(n)
}) )
```

`sha256` is SHA-256 returned as `sha256:<64 hex>`; `canonicalJSON` is RFC 8785 (JCS)
serialisation; `payload` and `requirements` are the bytes as presented — not decoded, not
re-serialised — each hashed first, the digest entering the object; and `n` is the 1-based
ordinal of this presentation of the payload. Two presentations of one payload differ only
in `presentation`, so a settled attempt and its refused replay resolve to two identities
(§3).

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
| `insufficient_funds` | `issuer_asserted` | balance does not cover the authorized amount (§5.1) |
| `duplicate_payment` | `chain_verifiable` | the proof was already settled |
| `nonce_already_used` | `chain_verifiable` | the authorization nonce is consumed |
| `transfer_leg_failed` | `issuer_asserted` | the authorization leg executed and the transfer leg did not, in one attempt (§15). Closes here, not at `chain_verifiable` — see §15.5 |
| `facilitator_timeout` | `issuer_asserted` | the facilitator did not answer in budget |
| `risk_policy_rejected` | `issuer_asserted` | declined by an undisclosed policy |
| `commercial_refusal` | `issuer_asserted` | declined on business grounds, no technical cause |
| `internal_error` | `issuer_asserted` | the seller failed and is not claiming a cause |
| anything else | `issuer_asserted` | fail closed: an unreviewed reason never sounds rigorous |

`insufficient_funds` is the one `chain_verifiable` reason whose check is not monotonic. A
nonce, once consumed, is consumed; a settlement, once landed, is landed. A balance is a
value at a block, and this format carries no block reference, so the balance this refusal
saw cannot be reproduced by a third party — only a similar one at a later block. The table
above records `issuer_asserted` for this reason rather than the `chain_verifiable` it could
reach if a row carried a block reference, because a ceiling column that names an unreachable
class is a column a reader will follow into a rejection. If a later version adds a block
reference, this row moves back up.

Three reasons also exist to describe a repeat presentation, and they are not the same fact:

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

A rotation is the quieter case this section does not yet cover. When the merchant rotates
its signing key, every claim signed with the old key stops verifying unless the old key is
still resolvable. A merchant SHOULD keep retired `verificationMethod` entries published
when it rotates, and MUST NOT reuse a key fragment for a different key, so a claim issued
before a rotation stays checkable and a fragment never silently changes meaning.

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
sha256(canonicalJSON({ spec: 'sycee/refusal/v0.1',
                       payload: sha256(payload),
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


## 15. Split-leg authorization: the refusal a scheme cannot make attributable

Everything above assumes a refusal is a statement about a decision. Some refusals are
statements about a *scheme*, and the difference has to be written down before it gets quietly
folded into the reason table.

### 15.1 The two shapes

A payment scheme reaches the rail in one of two shapes.

**One-leg.** The authorization and the transfer are the same call. EIP-3009's
`transferWithAuthorization` is the reference case: the nonce is consumed and the balance moves
in one transaction, so the two cannot disagree, and there is no state in which the first
succeeded and the second did not.

**Split-leg.** The authorization and the transfer are separate calls. Permit2 is the reference
case, and it arrives through x402 already: an asset that does not implement EIP-3009 is listed
with `assetTransferMethod: permit2`, and clients are pointed at ERC-20 Approval Gas Sponsoring
for the one-time approval ([x402 PR #3514](https://github.com/x402-foundation/x402/pull/3514),
merged 2026-11-17, adds USDs on Arbitrum One in exactly this shape). `permit()` consumes the
nonce and sets an allowance; `transferFrom()` moves the balance. Between them there is a state
the one-leg shape cannot produce:

> the nonce is spent, the allowance is set, the balance has not moved, and a retry carrying the
> same signature is rejected because the nonce is spent.

Call it the **drift state**. It is not hypothetical, and it is not a bug in Permit2: it is what
a two-call authorization means when the second call does not land.

### 15.2 Why the one-leg case is not affected

The temptation is to treat the drift state as a generic "partial execution" and give every
scheme a new reason. That would be wrong, and saying why is the point of this section.

Under a one-leg scheme, `authorizationState(authorizer, nonce)` returns true only after the
transfer executed. Reading it as spent is a *negative* observation with exact carryover: the
nonce cannot be spent by an attempt that did not execute, so "spent" refutes exactly this
attempt. The marker is scoped to the attempt's own signature, so a third party can attribute
it. (Reading it as unspent carries no such force — it may simply mean the attempt was never
broadcast — which is why no reason in §5 rests on that reading.) Nothing here needs a new reason, and `nonce_already_used` and `insufficient_funds` keep the
meanings §5 already gives them.

Under a split-leg scheme the second leg carries no equivalent marker. The ledger shows that a
balance moved; it does not show which attempt moved it. That asymmetry — not the number of
calls — is what this section is about.

### 15.3 The reason

`transfer_leg_failed` enters the closed set of §5:

| `reason` | Ceiling | Meaning |
|---|---|---|
| `transfer_leg_failed` | `chain_verifiable` | the authorization leg executed and the transfer leg did not, in the same attempt |

The base ceiling reflects that both legs are public. §15.4 then takes most of it away, which is
the intended shape: the ceiling names what the reason could support, and the reproducibility
rule names what a row may actually claim.

A merchant whose transfer leg was submitted and returned nothing conclusive does not use this
reason. "It reverted" and "I submitted it and learned nothing" are different sentences, and a
row that merges them is doing the drift this section exists to name. The second case is
`facilitator_timeout` or `internal_error`, whichever is true.

### 15.4 The row must record what it saw, not what it infers

A refusal gains an optional `legs` object:

| `legs.<leg>.status` | Meaning |
|---|---|
| `not_reached` | the merchant never submitted this leg |
| `executed` | the merchant observed this leg complete |
| `failed` | the merchant observed this leg revert or be rejected |
| `unknown` | the merchant submitted this leg and learned nothing conclusive |

with `legs` keys drawn from `{ authorization, transfer }` and nothing else.

**L1.** A refused row MAY omit `legs`. Omitting it asserts nothing about either leg; it is not
equivalent to recording both as failed.

**L2.** When `legs` is present, a reason that makes a causal claim about a leg MUST record that
leg, and the recorded status MUST be one the reason permits. A reason that makes no leg claim
(`wrong_amount`, `authorization_expired`) MUST NOT carry leg observations that contradict the
absence of a claim.

The permitted statuses are part of the format, not of one implementation, so they are listed
here. A row whose recorded status is outside its reason's row is rejected with
`leg_contradicts_reason`; a row that omits a leg the reason requires is rejected with
`leg_not_observed`.

| `reason` | `authorization` | `transfer` |
|---|---|---|
| `invalid_signature` | `failed`, `unknown` | — |
| `wrong_amount` | `failed`, `unknown` | — |
| `wrong_recipient` | `failed`, `unknown` | — |
| `malformed_payload` | `failed`, `unknown`, `not_reached` | — |
| `authorization_expired` | `failed`, `unknown` | — |
| `authorization_not_yet_valid` | `failed`, `unknown` | — |
| `insufficient_funds` | `failed`, `unknown` | — |
| `nonce_already_used` | `failed`, `executed` | — |
| `transfer_leg_failed` | `executed` | `failed` |
| `facilitator_timeout` | `unknown` | — |
| `internal_error` | `executed`, `unknown` | — |
| `risk_policy_rejected` | `not_reached`, `unknown` | — |
| `commercial_refusal` | `not_reached`, `unknown` | — |
| `replay_already_settled` | `executed` | — |
| `replay_in_flight` | — | — |
| `could_not_compare` | — | — |
| anything else | not pinned; the reason is unknown and the row already fails closed | — |

— means the leg is neither required nor forbidden: the reason claims nothing about it, so
recording it or leaving it out both stand, provided the status is legal under the table in
15.4.

Two entries carry the weight of this section. `transfer_leg_failed` is pinned on **both** legs,
because the sentence is a conjunction: a merchant that did not observe the authorization run
cannot claim it ran, and one that did not observe the transfer conclude cannot claim it failed.
A merchant in that position uses `facilitator_timeout` or `internal_error`, per 15.3.
`nonce_already_used` admits `executed` because the nonce being spent is a negative read on the
attempt's own signature — the transfer having run beside it does not weaken the claim (15.2).

**L3.** An unknown leg name, or an unknown status, is a malformed row. It is rejected with
`unknown_leg` or `unknown_leg_status`, not ignored: a reader cannot tell an ignored field from
a field that was never written.

### 15.5 Reproducibility: why `transfer_leg_failed` closes at `issuer_asserted`

The claim "the transfer leg of this attempt executed and then failed" rests on a positive
observation of a balance movement that the ledger cannot attribute to one attempt. The honest
class for it is therefore `issuer_asserted`, and a row that claims `chain_verifiable` for this
reason is rejected at construction:

```
refusalRow: evidence chain_verifiable is not reproducible —
  chain_verifiable exceeds a reproducible ceiling of issuer_asserted
```

The general rule, stated so it can be applied to schemes that do not exist yet:

> A reason may claim an evidence class only if every leg whose execution it depends on carries
> a marker a third party can attribute to a single attempt. A positive marker that is shared by
> every attempt against the same account is not such a marker.

Under a one-leg scheme the marker is the nonce, which is per-attempt, so the rule changes
nothing there. Under a split-leg scheme the transfer leg's marker is a balance change, which is
per-account, so the rule removes the claim. **The rule is written over markers, not over
schemes, because the schemes are still arriving.**

### 15.6 What this does not fix

The drift state is still reachable, and this section does not prevent it. It makes it
*reportable*: a merchant that hits it can record one row that says which leg ran, which leg did
not, and what a third party is entitled to conclude from that. That is a smaller claim than
"settlement outcome is defined", and it is the claim the format can actually support.

The larger fix — a per-attempt marker on the transfer leg, so that a third party can attribute
the movement — is a scheme change, not a format change. Nothing in x402 or in Permit2 provides
one today, and this document does not propose one. It makes the absence legible, which is the
precondition for anyone proposing one.

### 15.7 Conformance

- `packages/core/test/legs.test.mjs` — 13 tests, including four mutants, one per rule: dropping
  the leg contract, treating `unknown` as `failed`, trusting the caller-supplied evidence class,
  and letting an unknown leg pass.
- `packages/core/src/refusal.mjs` — `legSupport`, `reproducibleCeiling`, `REQUIRED_LEG_STATUS`,
  `DEPENDS_ON_EXECUTED`, `THE_UNATTRIBUTED_BALANCE`.
- The default `evidence_class` for a refused row is the reproducible ceiling, not the reason's
  base ceiling. A row that picks its own default would claim more than anyone can check by
  omission, which is the same failure as over-claiming on purpose.
- `conformance/refusal/` — 48 known-answer files and a judge, `node conformance/refusal/judge.mjs
  --expect=48`. Sixteen accepted vectors, each with a `-wrong` twin; sixteen rejected vectors, each
  with an accepted near miss; two implementations, one in JavaScript against the constructor and
  one in Python from the prose above.

  The word "independently" used to sit in that sentence. It does not belong there: one person
  wrote both implementations and the prose, so the two agreeing says the author is consistent
  with himself, not that the text is unambiguous. That distinction is not a technicality — the
  pairs below were accepted by both implementations while contradicting the prose, and nothing
  in this directory noticed until a reader who had only the prose was asked to build one.

#### 15.7.1 Why a unit test is not enough

The tests above answer a narrow question: when the rule is removed, does something fail. They
cannot answer the question a reader of this section actually has, which is whether their own
implementation — written from the prose, by someone who has not read the tests — computes the
right answer.

The difference matters concretely. If a wrong answer only has to *differ* from the recorded one,
then an implementation that returns the same constant for every field passes every wrong vector,
for a reason unrelated to the rule under test; it also passes every accepted vector, because
half of them are `issuer_asserted` by design. Such a checker reports a clean run while measuring
nothing.

So every accepted vector carries a **wrong twin**: the same input, a plausible wrong answer. An
implementation must compute, on the wrong file, the value its *right twin* records. Differing is
not the test; differing for the right reason is. The near-miss twins on the rejected family do
the same work from the other side: a constructor that refuses everything fails, because the file
it should have accepted is right there beside it.

The judge is a pure function so that the claim is testable rather than asserted. Its own test
suite feeds it four degenerate implementations — a constant, an accept-everything, a
refuse-everything, and the plausible mistake of taking `transfer_leg_failed`'s base ceiling as
its default — and requires a violation for each. A judge that has only ever been run against
correct input has been run, not tested.

The shape of this directory follows `interop/` in
[holistis/agent-receipt-verify](https://github.com/holistis/agent-receipt-verify), where the twin
rule was first written down against the §5.5 known-answer vectors. The vectors and both checkers
here are independent of that repository, and the debt is worth naming: the rule that makes a
degenerate implementation visible came from reading someone else's harness, not from this
document.
