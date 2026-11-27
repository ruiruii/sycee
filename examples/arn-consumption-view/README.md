# SYCEE external consumption view over ARN receipts

A minimal, runnable reference for the idea in `../arn-receipt-mapping.md`:
**build a consumption-side attempt view on top of an ARN receipt, externally,
without changing the ARN schema or asking anyone's permission.**

## Why this is possible

ARN's `arn-receipt/0.1` has exactly one field a downstream layer can join on:
`settlement.txHash`. It has no attempt id, no consumption state, no redemption
count, and it refuses unknown fields. So the bridge cannot be "add fields" —
it has to be external correlation:

- **join key** = `settlement.txHash` (ARN's payment anchor)
- **attempt identity** = derived from the *request as sent*, per SYCEE SPEC §5.5.4:

  ```
  attempt_identity = sha256("sycee/attempt/v1" | method | origin | path | query
                            | payTo | asset | network | amount | scheme)
  ```

  derived once at ingress, never from the receipt/payment payload. A settled
  attempt and its refused replay share one identity and differ in `presentation`.

- **consumption facts** = `consumed` / `redeem_count`, observed by the buyer
  runtime and never written back into ARN.

This means SYCEE can become the consumption-layer view **unilaterally**. No ARN
schema change, no declare-key, no submitted receipt, no funds, no arbitration.

## Files

| File | What it is |
|---|---|
| `attempt_view.py` | Reference implementation: read receipt (read-only), compute attempt identity, classify delivery, build a consumption view, reconcile. |
| `demo-output.txt` | Output of `python3.11 attempt_view.py` on the ARN Scenario 1 sample (placeholder values). |
| `README.md` | This file. |

## Run it

```bash
python3.11 attempt_view.py            # prints a consumption view (JSON)
python3.11 attempt_view.py --self-test # checks the 5 key invariants
```

Standard library only, Python 3.11+.

## What the self-test pins

1. The zero hash is classified as `signed_nothing_delivered` — a definite
   value, not missing data.
2. `attempt_identity` is stable, and an empty query equals an absent query.
3. A settled attempt and its refused replay share one identity (differ by
   `presentation`).
4. A `|` in any request member is refused rather than escaped.
5. The produced view never claims ARN's schema was changed.

## The seam this documents

| ARN proves | SYCEE observes |
|---|---|
| payment settled (`txHash` + on-chain Transfer + declared-key ed25519) | whether the result was consumed, how many times redeemed, reconciliation |
| `outputHash` (submitter's claim; zero hash = signed "nothing delivered") | consumed = yes / no / unknown; redeem_count ≥ 1 |

The two layers join on `txHash`. Neither substitutes for the other:
`one receipt per tx ever` is payment-layer dedup, not attempt-layer identity.

## Scope / honesty notes

- The demo uses the ARN **sample payload**, which uses placeholder hashes and
  addresses. This is a structural demonstration, not a verification of a real
  transaction.
- `read_arn_receipt()` deliberately does **not** verify the ed25519 signature or
  the on-chain Transfer — those are the issuer's and ARN's responsibility. This
  tool only reads fields a downstream consumer is entitled to use.
- `consumed` here is a plain observation; SPEC §4 requires `yes|no` to be
  signed only by the buyer (agent) role. This reference stays signer-agnostic
  on purpose; a production implementation follows that rule.

Repo: https://github.com/ruiruii/sycee
