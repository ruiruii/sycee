# Methodology, Blind Spots, and Appeals

> The standard we apply to the parties we measure: **publish verifiable evidence.**
> The standard we apply to ourselves: **the same one.**
>
> This document states what we measure, what we cannot measure, and what happens when we get a call wrong. It is part of gates-probe's credibility and is versioned alongside the method.

**Current method version: `v1.1`** — the version is written into every report so the time series stays comparable.

---

## 1. Why this document exists

The value of a referee position comes from credibility, and credibility comes from being checkable. An outfit that publishes conclusions without publishing the measurements behind them, without naming its own blind spots, and without accepting challenges, is not a referee — it is a blogger.

So four rules apply to us as well:

1. **Every verdict must ship with its measurement.** This is enforced in the pipeline: a verdict with no measured value behind it is published as `unsubstantiated` — never silently published.
2. **Blind spots must be published.** See §3.
3. **Verdicts must be challengeable.** See §4.
4. **Method changes must leave a trace.** See §5.

---

## 2. What we measure, and how

| Item | Method |
|---|---|
| Evidence surface | Probe each endpoint for `/v2/ledger`, `/v2/pubkey`, `/v1/receipt-key` (authority layer additionally `/supported`, `/health`) |
| Threshold for "exists" | **2xx AND a JSON body.** HTML landing pages and error pages are never counted — this is what prevents a page that merely *looks* like a ledger from being scored as real attestation |
| Reachability | Any HTTP response (including 404) from any probed path counts as reachable; only total silence is unreachable — so a live endpoint that simply does not attest is not misreported as down |
| Ledger depth | Seven predicates: `hashIntegrity`, `chainContinuity`, `keyring.historyAware`, `contentBinding`, `settlementLinkage`, `redeemCountDerivable`, `settlementTrivalued` |
| Content binding | Count and distribution of entries whose `dataHash === sha256("{}")` — a signature over an empty object is *evidentially empty* |
| Data source | Unauthenticated requests to public endpoints. We require no internal access and custody no assets |

---

## 3. Blind spots — what we cannot measure

Published honestly, because **selectively publishing only what we can prove is itself a bias**.

| # | Blind spot | Consequence |
|---|---|---|
| 1 | **Only publicly exposed surfaces are measured** | `no-evidence` means no surface of the kind we define was exposed. It does **not** mean the party keeps no internal records |
| 2 | **The seller population is bounded by the discovery directories** | Our endpoint pool comes from the public Circle / CDP directories. Endpoints not listed are invisible to us — there is **coverage bias**: 77 is a lower bound, not the full set |
| 3 | **One snapshot per week** | Transient states and intermittent failures are missed |
| 4 | **Reachability depends on runner geography** | Unreachable from a GitHub-hosted runner ≠ unreachable globally, and vice versa |
| 5 | **The signed-receipt form is assessed more shallowly** | Ledgers get the full seven predicates; the receipt form needs sample receipts or format documentation for deep assessment (e.g. bsvkey: 6 of 7 dimensions unverified — stated plainly, not hidden) |
| 6 | **`settlementLinkage` / `redeemCountDerivable` are often `pending`** | Both depend on the party publishing a request fingerprint. Absent it, we report `pending`: that is a gap in **our** information, not a defect in their implementation |
| 7 | **No identity or attribution judgement** | We judge endpoint behaviour, not who operates it or whether they are trustworthy |
| 8 | **No composite score, trust rating, or certification mark** | We publish per-predicate measurements of public evidence surfaces. We do not produce a composite score, a trust rating, or a certification mark, and we are not selling scores. |

> Item 2 matters most. **"3% coverage" means 3% of what we can see.** The true ecosystem may be larger, which would make real coverage even lower. We will not blur this to make the narrative tidier.

---

## 4. Appeals and corrections

**Any measured party may challenge any verdict about itself. We commit to handling that publicly.**

**Process:**

1. **File** — open an issue in the public repository naming the contested verdict and the reason (evidence or technical detail welcome).
2. **Acknowledge** — we confirm receipt and state an expected handling time (target ≤ 7 days).
3. **Re-examine** — we re-probe the endpoint and, where useful, check technical detail with the party.
4. **Decide** —
   - If the verdict was **wrong**: publish a correction, recorded in both the report and the machine-readable output.
   - If the verdict **stands**: publish the re-examination and its basis, and keep the verdict.
5. **Keep the record** — every appeal and outcome enters the public correction log (§6). **Historic verdicts are never deleted**; corrected ones are marked as corrected, so the time series stays auditable.

**What we do not promise:** we do not change a published measurement because of payment, partnership, or commercial pressure. Payment, partnership, or a pilot does not change a published measurement. A measured party may appeal via a public issue.

---

## 5. Method versioning and comparability

| Version | Change | Effect |
|---|---|---|
| `v1.0` | Two-layer census (authority + seller), seven predicates, HTML false-positive rejection | baseline |
| `v1.1` | ① verdicts must publish supporting measurements (new report §4.1) ② unsupported verdicts marked `unsubstantiated` ③ machine-readable `reports/w1.json` added ④ method version and reproducibility declaration placed **before** any conclusion | **Verdict values themselves are unchanged** — comparability unaffected |

**Rule:** if a future method change alters what a verdict *means*, we mark the break explicitly in the report and **do not mix verdicts from different method versions into a single trend line.**

---

## 6. Correction log

_(None yet. Corrections will be recorded here in reverse chronological order: date · endpoint · original verdict · corrected verdict · reason · how it was re-examined.)_

---

## 7. Reproducing

```bash
node tools/w1/discover.mjs --out endpoints.txt --sellers-out sellers.txt --discovery-out discovery.json
node tools/w1/scan.mjs     --list endpoints.txt --sellers sellers.txt --out w1-raw.json
node tools/w1/report.mjs
```

Artifacts:

- `reports/w1.md` — human-readable
- `reports/w1.json` — machine-readable
- `tools/w1/w1-raw.json` — raw measurements, including the values and evidence behind every predicate

---

## 8. In one line

> **We publish per-predicate measurements of public evidence surfaces, so we have to be reproducible first: measurements carry their evidence, blind spots are published up front, a measured party may appeal via a public issue, and the method carries a version. We do not produce a composite score, a trust rating, or a certification mark, and we are not selling scores.**
