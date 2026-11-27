# Reading ARN receipts as consumption evidence: what's there, what isn't

**SYCEE × `arn-receipt/0.1` — external read-only mapping**
Date: 2026-11-27 · Status: structural mapping against the published sample pack (placeholder values; not a verification of a real receipt).

> This document is deliberately public and citable. It states what a downstream consumption-evidence layer can and cannot read from an ARN receipt, so that anyone integrating ARN can see where payment attestation ends and consumption evidence begins. It does not propose changing the ARN format.

---

## 1. Why this document exists

ARN attests that a payment settled. It explicitly does **not** render a dispute verdict, and its own sample pack names a "downstream consumption / proof-redemption layer" as the consumer of the receipt as metadata. This note answers one question precisely:

> Given an `arn-receipt/0.1`, what can SYCEE take as evidence input, and what must it observe on its own?

The answer matters because the boundary is neither "ARN covers everything" nor "the two formats are incompatible." They are adjacent layers, and the seam is well-defined.

---

## 2. What the receipt actually carries

Schema (`arn-receipt/0.1`, Mode A "alongside"):

| Field | Value in sample | Meaning |
|---|---|---|
| `version` | `arn-receipt/0.1` | Literal; one format, no per-integrator adapters, unknown fields refused |
| `network` | `eip155:84532` | Base Sepolia only |
| `settlement.txHash` | `0x…00` | Already-mined settlement tx |
| `settlement.asset` | test-USDC address | Test USDC only |
| `settlement.payer` / `payTo` | `0x…00` | payer → payTo |
| `settlement.amount` | `"10000"` | Atomic units, string (0.01 USDC) |
| `outputHash` | `sha256:000…000` | `sha256` of the delivered output; **required**, no empty/optional form |
| `issuedAt` | ISO 8601 UTC | Issue time |
| `signatures` | ed25519 (ML-DSA-65 not verified) | Signed over canonical receipt without `signatures` |

Acceptance checks: schema → network/asset → declared-key ed25519 → **one receipt per tx hash, ever** (persistent registry) → on-chain read confirming test-USDC `Transfer(payer→payTo, amount)`.

---

## 3. The zero hash is a definite value, not missing data

The most important semantic point, confirmed in writing by the ARN team on 2026-11-25 and restated in the session recap:

- In Scenario 1 ("paid but not delivered"), the receipt carries `outputHash = sha256:` + 64 zeros.
- That zero hash is a **signed sentinel** meaning **"settled, and nothing was delivered"** — not "we failed to capture the hash."
- The format has no "not captured" state; a receipt is only issued with a defined value.

Consequence for a downstream reader: `outputHash == ZERO_HASH` is a first-class, verifiable observation. It is evidence of non-delivery, not an absence of evidence. A consumption layer can treat it as a definite input.

---

## 4. Mapping: read / weak / absent

| SYCEE observation | In an ARN receipt | Coverage | Reading |
|---|---|---|---|
| **settled** (payment occurred) | `settlement.txHash` + on-chain `Transfer` check + declared-key ed25519 | **Strong** | Signed, independently verifiable. Good evidence input. |
| payer / payTo / exact amount | `settlement.payer / payTo / amount` | **Strong** | Exact, unambiguous, atomic units. |
| **delivered** | `outputHash` only, self-declared by submitter | **Weak** | ARN does not verify delivery. Zero hash = signed "nothing delivered"; non-zero hash = submitter's claim about bytes, not verified. |
| **consumed** (result actually used) | — | **Absent** | Core SYCEE position. Not covered by ARN, by design. |
| **redeem_count** | — | **Absent** | Only `one receipt per tx ever` exists — that is payment-layer dedup, not attempt-layer redemption count. |
| **attempt identity** | — | **Absent** | No attempt id, idempotency key, or offer fingerprint. |
| Correlation key | `txHash` only | **Partial** | Anchors the payment; cannot anchor a request/offer/attempt. |
| Extensibility | `unknown fields refused`, no adapters | **None** | SYCEE fields cannot be embedded; external correlation is the only route. |

---

## 5. The two boundaries that matter

**Boundary 1 — `outputHash` stops at "delivered", not "consumed."**
Even a non-zero `outputHash` is the submitter's claim about delivered bytes. ARN grades structure and settlement, not whether the buyer's runtime ever referenced the result. `consumed = yes | no | unknown` is outside the receipt entirely.

**Boundary 2 — `one receipt per tx, ever` is payment dedup, not attempt identity.**
ARN guarantees one receipt per transaction. SYCEE's unit is the attempt — `attempt_identity = sha256("sycee/attempt/v1" | method | origin | path | query | payTo | asset | network | amount | scheme)`, derived once at ingress from the request as sent. One settlement can correspond to several attempts (retries, replays, refusals); one attempt can be presented more than once. The two dedup rules operate at different layers and do not substitute for each other.

---

## 6. How SYCEE reads the receipt (and what it adds)

SYCEE treats the receipt as **read-only metadata** and does three things externally:

1. **Anchor** — index the observed payment by `settlement.txHash`. This is the only shared key with ARN.
2. **Classify delivery** — map `outputHash`: zero hash → signed non-delivery; non-zero → submitter-claimed delivery (not verified by ARN).
3. **Add the missing layer** — on the SYCEE side, record `attempt_identity`, `consumed`, `redeem_count`, and reconciliation against the attempt the receipt paid for. None of these are written back into the ARN receipt.

This is why the formats are complementary rather than competing: ARN owns the settlement fact; SYCEE owns the consumption fact. The join key is `txHash`; the attempt view lives outside ARN and needs no change to its schema.

---

## 7. What this note does not claim

- The published sample uses placeholder hashes/addresses. This is a **structural** mapping, not a verification of a real transaction.
- "ARN does not verify delivery" is not a criticism — it is the format's stated scope. The seam is where SYCEE starts.
- Nothing here asks ARN to change `arn-receipt/0.1`. The correlation is external and read-only.

---

*SYCEE is an evidence layer for machine payments: attempt-level witness, consumption, proof redemption, and reconciliation. Repo: https://github.com/ruiruii/sycee*
