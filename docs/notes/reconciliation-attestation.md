# Reconciliation attestation (draft, v0.1)

**Status:** draft, not referenced by any conformance level. A signed attestation is an
artifact a buyer may publish; it is not a VSR and adds no field to one.

§10 defines how two ledgers are compared and forbids the comparison from deciding who is
right. This document defines the object that lets one side *say out loud* what it compared,
so the other side and any third party can check the claim without asking for logs.

The gap it closes: a `status_disagrees` verdict is private. It lives inside one party's
reconciler, on one machine. The moment it needs to be shown to the counterparty — or to a
dispute process — it either becomes a screenshot or a paragraph of prose, and both are
unfalsifiable. An attestation is the same verdict, signed, bounded, and expiring.

## 1. What it is not

This is the part that decides whether the object is useful or poisonous.

An attestation **MUST NOT** state, imply, or permit the inference of:

- that payment settled (the buyer cannot see the rail, §10);
- that the seller delivered (the buyer sees a response, not a delivery);
- that either party is at fault (a divergence is a deployment fact, not misconduct);
- an amount received (the buyer knows what it sent, not what arrived).

These are not stylistic preferences. A document that carries a fault field will be read as
an accusation, and the counterparty's rational response is to stop exchanging them. The
first attestation that gets used as evidence of wrongdoing ends the practice for everyone.

For the same reason the four prohibitions are **enumerated in the document itself**
(`scope.does_not_assert`), not left to a spec the reader has to find. A verifier that holds
only the artifact can see the boundary without trusting the author.

## 2. Shape

```json
{
  "attestation": {
    "schema_version": "sycee/reconcile-attestation/v0.1",
    "attestation_id": "sha256:…",
    "issued_at": "2026-11-26T14:40:00.000Z",
    "expires_at": "2027-02-24T14:40:00.000Z",
    "signer": { "public_key": "ed25519:…", "key_id": "buyer-2026-11", "role": "agent" },
    "subject": {
      "attempt_identity": "sha256:…",
      "resource_id": "search.v1",
      "proof_hash": "sha256:…",
      "seller_receipt_hash": "sha256:…",
      "receipt_status": "verified"
    },
    "observation": {
      "outcome": "served",
      "http_status": 200,
      "members": { "origin": "sha256:…", "query": null, "path": "sha256:…" }
    },
    "divergence": { "verdict": "only_seller", "members": ["origin"] },
    "scope": {
      "asserts": ["buyer_observation", "member_digests", "identity_composition"],
      "does_not_assert": ["settlement", "delivery", "fault", "amount_received"]
    }
  },
  "signature": "…"
}
```

Schema: [`schema/reconcile-attestation-v0.1.schema.json`](../../schema/reconcile-attestation-v0.1.schema.json).

| Field | Why it is there |
|---|---|
| `subject.attempt_identity` | The join key. Composed by the buyer at ingress (§3.1), never copied from the seller — a copied key makes every comparison pass by construction |
| `subject.seller_receipt_hash` | Pins the attestation to **one** seller envelope. Without it the claim can be re-attached to a different receipt and still look consistent |
| `subject.receipt_status` | Distinguishes "no receipt exists" from "a receipt exists and does not verify". Collapsing them lets a broken signature hide inside `only_buyer` |
| `observation.members` | The buyer's own per-member digests, same shape as `x-sycee-members`. This is what turns "hashes differ" into "this member differs" |
| `divergence.verdict` | One of the four §10 verdicts, plus `unidentified` for attempts whose identity could not be composed |
| `divergence.members` | Named members only. Empty is legal: it means the divergence exists but was not located |
| `scope` | The boundary, carried with the claim |

## 3. Rules

**R1 — Signature scope.** `signature` is Ed25519 over `canonicalJSON(attestation)`, the same
canonicalization as §7.1. `attestation_id` is `sha256` over the same bytes with
`attestation_id` removed. A verifier MUST recompute both and MUST reject on mismatch.

**R2 — Only the buyer signs.** `signer.role` is `agent`. A seller-signed attestation is
malformed, not merely unusual: every field in `observation` is something only the requesting
party can see.

**R3 — Credentials stay null.** A member that carries a credential — in practice `query` —
MUST be `null`, never a digest. A short query is recoverable from its digest by trying
plausible values. The buyer already knows what it sent; nobody else needs to.

**R4 — No adjudication fields.** `scope.does_not_assert` is a fixed enum. A document
carrying `fault`, `liable_party`, `settled`, or a free-text `note` is non-conforming, because
free text is where the accusation always ends up.

**R5 — One attempt per attestation.** An attestation covers exactly one
`attempt_identity`. Bulk attestations are a report, and a report is not signed evidence.

**R6 — Expiry is mandatory.** `expires_at` MUST be present and SHOULD be at most 90 days
after `issued_at`. Past it, the signature still verifies; the claim is stale. A dispute
that needs an older snapshot re-issues, which is the point — re-issuing is a deliberate act.

**R7 — Generation is not publication.** A tool that produces an attestation MUST NOT publish
it. Publication is a separate, explicit act by the buyer, aimed at a named counterparty.
This is the operational form of the rule that the buyer's data does not leave the buyer
without the buyer deciding.

## 4. Verification

Five checks, in this order. A verifier that stops early reports a weaker claim, not a
failure.

1. **Schema** — required fields present, enums respected, `additionalProperties: false`.
2. **Canonical hash** — recompute `attestation_id`; recompute `signature` over
   `canonicalJSON(attestation)`; resolve `signer.public_key`.
3. **Receipt pinning** — if `receipt_status` is `verified`, fetch or receive the seller
   envelope, verify it independently (§7.3), and recompute `seller_receipt_hash`. A mismatch
   means the attestation describes a different receipt than the one presented.
4. **Identity consistency** — recompute `attempt_identity` from the request as sent and the
   challenge as received. An attestation whose identity cannot be reproduced from the
   artifacts is a claim, not a check.
5. **Expiry** — compare `expires_at` to now; report `stale` separately from `invalid`.

## 5. What a reader may conclude

| Reader | May conclude | May not conclude |
|---|---|---|
| The seller | This buyer recorded this attempt, composed these member digests, and reports this verdict at this time | That the buyer paid, or that the response was not delivered |
| A third party | The document was signed by that key, is internally consistent, and has not been altered | Which party's account is correct |
| A dispute process | Two accounts were compared on a stated identity, and the divergence is located to named members | Fault, liability, or an amount owed |

`only_seller` deserves its own line: it is equally what a buyer with logging disabled
produces. It is a request to look, and an attestation that frames it as a finding is
non-conforming under R4.

## 6. Receiving one

A seller that receives an attestation has three honest responses, and all three are
acceptable:

1. **Counter-attest.** Publish its own `x-sycee-members` for the same attempt and let the
   member digests be compared side by side. This is the cheapest and the most convincing.
2. **Explain the member.** State that `origin` differs because of a proxy configuration,
   with the commit or config line. A named cause ends the disagreement faster than a rebuttal.
3. **Decline.** Silence is not admission, and the spec does not treat it as one.

An attestation nobody answers is still useful: it fixes what the buyer claimed, at a time,
under a signature. That is the whole product — not agreement, but a stable reference both
sides can point at later.

## 7. Relationship to the rest

- §10 defines the verdicts; this document adds no verdict and cannot loosen one.
- §3.1 defines the identity; R4 of that section still applies — the buyer composes, never adopts.
- `x-sycee-members` is the header form of `observation.members`. The header is for a live
  response; the attestation is for a dispute, which happens days later when the response is gone.
- A seller's `termsHash` / `responseHash` are object-level anchors. `observation.members` is
  the level below them: when the object hash fails, this is what says where.
