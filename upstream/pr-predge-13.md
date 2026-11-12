> **Name note.** This was sent when the project was called `gates-spec` (posted as [predgeAI/erc8004-outcome-validator#14](https://github.com/predgeAI/erc8004-outcome-validator/pull/14), which closes issue #13). The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged.

Opening PR body for predgeAI/erc8004-outcome-validator#13.

---

Opening this as a PR rather than leaving it as an issue, because the change is small and
easier to judge as a diff.

## What this adds

Two optional, off-chain fields to the pay-per-call receipt in `monad/x402/`:

| Field | Side | Meaning |
|---|---|---|
| `payment.redeem_count` | seller | How many times the seller **saw** this payment proof. Counted as *attempts* — a replay, a retry or a refused second redemption all increment. |
| `result.consumed` | buyer | `yes` / `no` / `unknown`, default `unknown`. Whether the buyer runtime referenced the paid result downstream. |

## Why

Predge's receipt proves *what was bought* and *that it was paid for*. Two things it does not
answer, and which I could not find defined in any receipt spec:

1. **Did the buyer actually use the result?** An agent can pay, get a perfectly valid record,
   and never reference it downstream — budget exhausted, a downstream step discarded it, a
   retry superseded it. Real cost, zero downstream effect, indistinguishable from a used
   result.
2. **How many times was the same payment proof redeemed?** x402 permits multiple `complete`
   transitions for one proof; in-flight dedup prevents *concurrent* replay but records
   nothing.

## Two details I want to flag, because they are where this usually goes wrong

**`redeem_count` counts attempts, not completed redemptions.** Under `exact` (EIP-3009) the
nonce is single-use, so a *completed* second redemption is structurally impossible. If the
field were defined as "accepted", it would read as broken forever at `1` rather than as
evidence. The server increments **before** it writes the response, so a refused retry is
still recorded.

**`consumed` is signed by the buyer, never by the seller.** The seller has no observation of
the buyer's runtime, so a seller-written `consumed` is unfalsifiable — the exact property
that splitting attestation from verdict exists to avoid. The default is `unknown`; absence
of a downstream reference is not evidence of idle spend. In this PR the buyer attests it
from the decision it derived from the record.

## Scope

- `monad/x402/spend-semantics.mjs` (new) — zero dependencies, `node:crypto` only.
- `server.mjs` — counts redemptions, adds `spend` to the response body plus an
  `x-predge-redeem-count` header, warns when `> 1`.
- `agent.mjs` — attests `consumed`, writes both fields into `runs/*.json`.
- `README.md` — documents the two fields and their semantics.

**No contract change. No new dependency. No change to the attestation or verdict path.** The
only change to an existing response is the additive `spend` key. The redemption counter is an
in-process `Map`; the README says plainly that a multi-instance deployment needs the same
interface over Redis rather than pretending otherwise.

## Naming

Field names follow [gates-spec v0.1](https://github.com/ruiruii/gates-spec) (Apache-2.0,
Ed25519, 9 byte-reproducible conformance vectors, CI on Node 18/20/22). If you prefer
different names — `used`, `utilized`, `redemption_count`, or names inside an existing
envelope field you already define — say so and I'll conform. The objective is one vocabulary,
not a new project.

Closes #13.
