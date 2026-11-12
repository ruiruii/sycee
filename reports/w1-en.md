# x402 Evidence-Layer Census · W1

**Generated:** 2026-10-10 18:26 UTC · **Tool:** gates-probe · **Method version:** `v1.1`
**Population:** 17 settlement authorities (16 reachable) + 60 seller origins (60 reachable)
**Ecosystem:** 150 public x402 resources listed across 2 discovery directories, 60 distinct seller origins

---

## 0. Reproducibility declaration

We ask the parties we measure to publish verifiable evidence, so we hold our own output to the same standard: every verdict below ships with the measurement behind it.

| Item | Value |
|---|---|
| Method version | `v1.1` |
| Scan time | 2026-10-10 18:26 UTC |
| Raw measurements (values + evidence behind every predicate) | [`tools/w1/w1-raw.json`](https://raw.githubusercontent.com/ruiruii/SYCEE/main/tools/w1/w1-raw.json) |
| Machine-readable output | `reports/w1.json` |
| Methodology, blind spots, appeals | [`TRANSPARENCY.en.md`](https://github.com/ruiruii/sycee/blob/main/TRANSPARENCY.en.md) |

**Verdict discipline:** any `gap` / `fail` / `pending` verdict must publish the measurement supporting it (§4.1). A verdict with no measured value is published as `unsubstantiated` — never silently. Unsupported verdicts this run: **0**.

---

## 1. Headline — ecosystem size vs evidence coverage

| Dimension | Count |
|---|--:|
| Public x402 resources (protected endpoints offered by sellers) | 150 |
| Distinct seller origins | 60 |
| Settlement authorities (facilitators + ledger / receipt services) | 17 |
| **Total endpoints probed (deduped union)** | **77** |
| **Endpoints exposing persistent, verifiable evidence** | **2** |

> **150 services are selling. 77 endpoints are live. Only 2 — roughly 3% — expose evidence that an independent party can verify.**

That is the gap the evidence layer exists to close. Note that this is 3% *of what we can see*: our endpoint pool comes from the public Circle and CDP discovery directories, so endpoints not listed there are invisible to us and real coverage may be lower still.

### What each form means

| Form | Meaning |
|---|---|
| `attestation-ledger` | A readable hash-chain ledger — durable, independently verifiable attestation |
| `signed-receipt` | Publishes signed receipts plus a key document — each delivery verifiable offline |
| `settlement-only` | A reachable x402 facilitator with **no durable evidence surface** — it settles, it does not attest |
| `no-evidence` | Reachable, but exposes none of the above (the norm for sellers) |
| `unreachable` | No connection |

---

## 2. Authority layer (17 facilitators / ledgers / receipt services)

| Form | Endpoints | Share |
|---|--:|--:|
| Hash-chain ledger (durable verifiable attestation) | 1 | 6% |
| Signed receipt + key document | 1 | 6% |
| Settlement-only (no attestation) | 14 | 82% |
| Unreachable | 1 | 6% |

**Finding:** of the public settlement authorities probed, exactly one exposes a hash-chain ledger and one exposes signed receipts. The other 14 settle without providing durable, verifiable attestation.

---

## 3. Seller layer (resource servers from the public discovery directories)

We probed all 60 deduped seller origins for whether they run **their own** durable evidence surface (ledger or receipt key). Sellers typically delegate settlement to a facilitator; this tests whether anyone attests.

| Form | Endpoints | Share |
|---|--:|--:|
| Reachable but no evidence surface | 60 | 100% |

**Finding:** **zero** seller origins run their own attestation surface. Combined with §2, this locates the gap structurally: the responsibility for attestation falls entirely on facilitators, and facilitators almost never do it.

---

## 4. Ledger depth — predicates (attestation-ledger form only)

Seven predicates. Status: `pass` holds · `gap` expected shortfall · `fail` real defect · `pending` missing input · `info` statement.

| Predicate | api.automaton-sovereign.workers.dev |
|---|--:|
| ledger.hashIntegrity | pass |
| ledger.chainContinuity | pass |
| keyring.historyAware | pass |
| evidence.contentBinding | gap |
| evidence.settlementLinkage | pending |
| evidence.redeemCountDerivable | pending |
| evidence.settlementTrivalued | info |

### 4.1 Measured values behind non-pass verdicts

Status alone is a claim; these are the measurements.

| Endpoint | Predicate | Status | Measured |
|---|---|---|---|
| api.automaton-sovereign.workers.dev | evidence.contentBinding | gap | **22 / 34 entries (64.7%) sign an empty object** — bound 12, ratio 0.353, at indices 12..33 |
| api.automaton-sovereign.workers.dev | evidence.settlementLinkage | pending | No request fingerprint published — the settlement-binding half cannot be tested |
| api.automaton-sovereign.workers.dev | evidence.redeemCountDerivable | pending | No fingerprint in scope; cannot confirm a count is derivable for a concrete request |
| api.automaton-sovereign.workers.dev | evidence.settlementTrivalued | info | Ledger entries carry no settlement-status field; trivaluation not observable here |

**What the contentBinding gap means.** `dataHash === sha256("{}")` is a signature over an empty object: cryptographically valid, evidentially empty. It proves *someone holding this key signed something at some time* — not *this content was delivered for this request*.

**The distribution matters more than the rate.** The 22 empty entries are **contiguous, indices 12–33**: the first 12 entries bind content correctly, then binding stops. That is the signature of a regression — a capability that existed and was lost — which makes it diagnosable and recoverable, not a redesign.

---

## 5. Per-endpoint detail

**Authority layer**

| Endpoint | Form | Surfaces present |
|---|---|---|
| https://api.automaton-sovereign.workers.dev | attestation-ledger | ledger, keyring, facilitatorSupported, facilitatorHealth |
| https://inference.bsvkey.com | signed-receipt | receiptKey |
| https://x402.org/facilitator | settlement-only | facilitatorSupported |
| https://api.cdp.coinbase.com | settlement-only | — |
| https://facilitator.payai.network | settlement-only | facilitatorSupported |
| https://facilitator.corbits.dev | unreachable | — |
| https://facilitator.x402.rs | settlement-only | facilitatorSupported |
| https://x402.dexter.cash | settlement-only | facilitatorSupported, facilitatorHealth |
| https://facilitator.heurist.xyz | settlement-only | facilitatorSupported |
| https://gateway.kobaru.io | settlement-only | facilitatorSupported, facilitatorHealth |
| https://facilitator.mogami.tech | settlement-only | facilitatorSupported |
| https://api.live.nevermined.app | settlement-only | facilitatorHealth |
| https://pay.openfacilitator.io | settlement-only | facilitatorSupported, facilitatorHealth |
| https://x402.solpay.cash | settlement-only | — |
| https://x402.primer.systems | settlement-only | facilitatorSupported, facilitatorHealth |
| https://facilitator.xechoai.xyz | settlement-only | facilitatorHealth |
| https://api.x402.celo.org | settlement-only | facilitatorSupported, facilitatorHealth |

**Seller layer** — all 60 origins: reachable, no evidence surface. Top 30 by resource count:

| Endpoint | Resources |
|---|--:|
| https://api.onesource.io | 30 |
| https://agentres.dev | 19 |
| https://agents.allium.so | 12 |
| https://api.aisa.one | 10 |
| https://x402.ottoai.services | 7 |
| https://agent.atinamos.co.uk | 4 |
| https://ausca.com | 4 |
| https://blockrun.ai | 3 |
| https://google-trends.use.x402atlas.com | 3 |
| https://api.exa.ai | 2 |
| https://api.oblique.markets | 2 |
| https://laso.finance | 2 |
| https://rubric-protocol.com | 2 |
| https://stableenrich.dev | 2 |
| https://stableupload.dev | 2 |
| https://vibesprings.net | 2 |
| https://2captcha.x402.paysponge.com | 1 |
| https://aero.lonestaroracle.xyz | 1 |
| https://africa.lonestaroracle.xyz | 1 |
| https://agentpay.tools | 1 |
| https://agi.apify.com | 1 |
| https://agri.lonestaroracle.xyz | 1 |
| https://analyst.lonestaroracle.xyz | 1 |
| https://api.402rates.com | 1 |
| https://api.aidress.ai | 1 |
| https://api.bitrefill.com | 1 |
| https://api.hyperextend.xyz | 1 |
| https://api.kadec0.xyz | 1 |
| https://api.loyalspark.online | 1 |
| https://api.solenrich.com | 1 |

---

## 6. Method

- **Form classification:** probe each endpoint for candidate surfaces (`/v2/ledger`, `/v2/pubkey`, `/v1/receipt-key`; authority layer additionally `/supported`, `/health`). A surface counts as present **only on 2xx with a JSON body** — HTML landing pages and error pages are excluded, which is what prevents false positives.
- **Reachability:** any HTTP response (including 404) from any probed path counts as reachable; only total silence is unreachable. This avoids reporting a live-but-non-attesting endpoint as down.
- **Seller layer** is asked only the evidence question (does it run its own ledger or receipt key), never facilitator-specific probes.
- **Ecosystem size** is taken from the public Circle / CDP x402 discovery directories.
- **contentBinding** counts entries whose `dataHash === sha256("{}")` — the empty-object signature.
- **settlementLinkage / redeemCountDerivable** require a published request fingerprint; absent it they report `pending`, which is a gap in our information rather than a defect in the implementation.

---

## 7. Sources and reproduction

```bash
node tools/w1/discover.mjs --out endpoints.txt --sellers-out sellers.txt --discovery-out discovery.json
node tools/w1/scan.mjs     --list endpoints.txt --sellers sellers.txt --out w1-raw.json
node tools/w1/report.mjs
```

- Endpoint list: public x402 facilitators plus ledger / receipt service seeds.
- Seller list: deduped origins of resource servers in the public Circle / CDP discovery directories.
- Ecosystem size: `GET https://api.circle.com/v2/x402/discovery/resources` and the CDP equivalent.

---

## 8. Known limitations

- We measure only **publicly exposed** evidence surfaces. `settlement-only` / `no-evidence` means no surface of the kind we define is exposed — not that the operator keeps no internal records.
- The seller population is bounded by what the discovery directories list; unlisted endpoints are invisible to us.
- One snapshot per week; transient states are missed.
- Reachability is judged from GitHub-hosted runners and may differ from other vantage points.
- The signed-receipt form is assessed more shallowly than ledgers: deep receipt-level assessment requires sample receipts or format documentation.
- This version reports coverage and per-predicate verdicts. We do not produce a composite score, a trust rating, or a certification mark, and we are not selling scores.

Full list: [`TRANSPARENCY.en.md`](https://github.com/ruiruii/sycee/blob/main/TRANSPARENCY.en.md) — including the appeals process, under which any measured party may contest any verdict about itself.

---

*gates-probe · independent attestation census · non-custodial · protocol-neutral*
