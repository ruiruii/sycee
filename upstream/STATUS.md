# Outreach status

One row per party we have contacted or plan to. The three columns that matter are
**state**, **what we asked**, and **what is owed**. Everything else is a link into
`upstream/` or `docs/observations.md`.

State is one of: `已回` (they replied), `未回` (sent, no reply), `拒绝` (declined),
`未发` (draft only), `已关` (the thread closed without a follow-up).

> This file is dated by construction: a `未回` older than two weeks is either a
> follow-up or a closed thread, never a silently open one. Update the date when the
> state changes, and move the old date into the note.

---

## Active

### StelarDigital — `x402-receipts#6` — **已回（多轮）**

- **State:** replied, five rounds. The maintainer (@baianomarceloeduardo-jpg)
  engaged substantively, corrected his own answer once, and handed us a real
  Base-mainnet payment to verify.
- **What we asked:** add `consumed` / `redeem_count` as a third predicate.
- **What we got:** five rounds of replies; one real payment vector (verified by us,
  see `vector-x402-receipts-base.md`); the maintainer walked back a wrong claim on
  his own initiative.
- **What is owed:** nothing to him right now. The thread is the most valuable line
  we have — it is the only one where a stranger replied with real data.
- **Next move:** check for new comments before contacting anyone new. If he is
  quiet, do not prod; the ball is not in our court.
- **Files:** `01-x402-receipts-proposal.md`, `issue-x402-receipts-consumed.md`,
  `reply-x402-receipts-6.md`, `reply-x402-receipts-6-round2..5.md`,
  `vector-x402-receipts-base.md`, `followup-x402-receipts-6.md`.

### holistis — `agent-receipt-verify` — **已回（多轮）**

- **State:** replied, multiple rounds. He read our §5.5, supplied eight more
  vectors, and — importantly — was the one who named the "same author" problem.
- **What we asked:** read our §5.5 / vectors; run each other's vectors.
- **What we got:** a genuine third-party read that caught real mistakes; eight
  vectors we read and reproduced (see `reading-attempt-identity-extra.md`).
- **What is owed:** we owe him the reciprocal run — his 22 + 8 vectors against our
  implementation — if he wants it. We offered; he has not confirmed.
- **New (2026-11-24):** he ran a **third independent read against sycee df240da**
  (commit `7b9fd4a`, PR #115) — beyond the two he had already done. His repo also
  added a vector-coverage tool with a profile for **our** refusal vectors
  (`2f7a7fa`), Edition 2 conformance over all 1,703 hosts of the index, and a
  Glama listing badge (2026-11-24). He is actively building around our vectors.
- **TSC line:** on 2026-11-24 we posted a short author-side note on `tsc#19`
  (https://github.com/x402-foundation/tsc/issues/19#issuecomment-7127785346),
  confirming 91d5c05a and the buyer-side NEG-3 data point. Note: the 25 Nov TSC
  meeting was **cancelled** (US Thanksgiving; next one 2026-12-09), and our agenda
  topic was never explicitly scheduled — hence the comment was written to stand
  without any meeting reference.
- **Next move:** he is a technical peer, not a customer and not a channel. The
  buyer-side sync note (`sync-holistis-buyer-side.md`) was finalised for Slack on
  2026-11-24 and handed to the user to post (Slack has no agent send channel);
  **not yet confirmed sent**. Do not write another 5,000-character letter.
- **Files:** `comment-holistis-110.md`, `reply-holistis-*.md`,
  `reading-attempt-identity-extra.md`, `sync-holistis-buyer-side.md`.

### Book0fEli / Lumière PayCheck — `lumiere-paycheck#60` — **已关（对方关闭，completed）**

- **State:** two rounds each way, then Elijah closed the issue himself
  (2026-11-26T18:27:16Z, `state_reason: completed`). Our reply to his closing note
  was posted **sixteen minutes after** the close (2026-11-27T03:52Z) and has not
  been answered. Treat this as a closed thread, not a pending one.
- **What we asked:** where the boundary between his signed test receipts and a
  post-payment reconciliation layer belongs; whether the per-member divergence
  idea was worth anything to him.
- **What we got:** the only case where a counterparty **changed their product**
  from our feedback. `responseBasis` (`body` / `async_result` / `empty`, null hash
  when no body, binary hashed as bytes) shipped in his release on 2026-11-26;
  per-member request digests followed. Both were our points.
- **What we found, and it held:** against a live receipt (2026-11-18,
  `marketintelligenceapi.com`) verified with his JWKS `paycheck-receipts-1`,
  `termsHash` does **not** recompute from the payload — the formula includes
  `scheme`, the payload carries no `scheme`, and inserting `scheme: "exact"`
  reproduces the digest exactly. So "compare with the live 402 to see terms haven't
  changed" needs a formula and a member the artifact does not contain.
- **What is owed:** nothing. Our fields and his do not interoperate yet, and the
  most we can claim honestly is that the feedback closed.
- **Next move:** none. Do not reopen, do not email. If he ships the fields
  publicly at https://lumierepaycheck.org/docs/receipts, that is a signal to pick
  up; until then this line is a **reference**, not a channel.
- **What it is worth as evidence:** one documented instance of a third party
  changing their shipped format in response to a SPEC critique. That is the
  strongest thing we have for a compatibility story, and it costs nothing to cite.
- **Files:** `/workspace/reply-bookofeli-final.md` (round 1),
  `/workspace/reply-bookofeli-r2.md` (round 2, includes the recompute check).

---

## Sent, no reply

### Sasona — `sasona-router#1` — **未回**

- **State:** sent 2026-11-21, no reply as of 2026-11-21.
- **What we asked:** a one-line question — why their README's Solana signature
  resolves to `null`.
- **What we got:** nothing back. (Their public claim is read in
  `docs/observations.md` §2; the Tempo half is verified, the Solana half is not.)
- **What is owed:** nothing. This is a question they can answer in one line.
- **Next move:** one follow-up, then archive. Do not chase; it was never a
  customer, it was a claim to check.
- **Files:** `reply-sasona-1.md`, `docs/observations.md` §2.

### Vauban Research — IETF x402 draft — **未回**

- **State:** email drafted, deadline is their draft expiry (2026-11-26/29). No
  reply on record.
- **What we asked:** align `consumed` / `redeem_count` as optional extensions
  before the draft expires.
- **What we got:** nothing back.
- **What is owed:** a follow-up only if the deadline still matters and we have a
  real address to send from (the note says a personal alias gets filtered).
- **Next move:** this is a **standards** line, not a **customer** line. If the
  expiry has passed, archive it — a late comment on an expired draft is noise.
- **Files:** `02-ietf-vauban-liaison.md`, `email-vauban-final.md`,
  `email-vauban-liaison.md`.

### Brave — `bx402#102` / `#141` — **未回**

- **State:** issue raised, no reply on record.
- **What we asked:** prevention (their fix) vs evidence (our `redeem_count`) are
  two halves.
- **What we got:** nothing back.
- **Next move:** archive unless they reply. A big-company repo issue is a lottery;
  do not spend another round on it.
- **Files:** `issue-brave-redeem-count.md`.

### predgeAI — `erc8004-outcome-validator#13/#14` — **未回**

- **State:** issue + PR raised, no reply on record.
- **What we asked:** reserve the receipt fields; the PR is small.
- **What we got:** nothing back.
- **Next move:** archive. The PR is a nice-to-have, not a dependency.
- **Files:** `issue-predge-receipt-fields.md`, `pr-predge-13.md`.

### ERC-8004 — `erc-8004-contracts#102` — **未回**

- **State:** issue raised, no reply on record.
- **What we asked:** reserve `consumed` / `redeem_count` in v2.
- **What we got:** nothing back.
- **Next move:** archive; overlaps with predge and Brave. One standards line on
  this is enough.
- **Files:** `03-erc8004-field-reservation.md`, `issue-erc8004-field-reservation.md`.

### Counterra — `#10` — **未回**

- **State:** issue raised 2026-10-09, no reply on record.
- **What we asked:** a demand-side (accounting) use of the fields.
- **What we got:** nothing back.
- **Next move:** archive. It was a "why this matters" post, not a customer.
- **Files:** `outreach-counterra-accounting.md`.

---

## Mentioned, not yet contacted directly

### Nirium / `nirholas/x402-facilitator` — **已发（2026-11-24）**

- **State:** issue opened 2026-11-24 at
  https://github.com/nirholas/x402-facilitator/issues/21 — leads with their own
  devlog (37 on-chain vs 39 receipts), asks for citation permission and one
  reconcile run, and raises the narrow EIP-2612 reporting question. Draft:
  `issue-nirium-facilitator.md`. Awaiting reply.
- **What they are:** the closest thing to a real seller with a real problem — the
  split-leg settlement that reports one boolean, and the 37-vs-39 gap.
- **What is owed / next move:** send the draft as a new issue (chosen over replying
  on #3, whose binding hole is closed and is a different question). It leads with
  their own devlog, asks for citation permission and one reconcile run, and raises
  the EIP-2612 reporting question without asking them to adopt our vocabulary.
- **Files:** `issue-nirium-facilitator.md`, `docs/observations.md` §1.

### vet402 / `kzmttkc` — **已发（2026-11-24）**

- **State:** replied 2026-11-24 on x402#4116 at
  https://github.com/x402-foundation/x402/issues/4116#issuecomment-7108861084 —
  picked up kzmttkc's own observation that a response-carried receipt cannot help
  when no response arrives; offered the buyer-side witness + four-outcome reconcile
  as complement, not competitor. Draft: `reply-x402-4116-vet402.md`. Awaiting reply.
- **What they are:** the buyer-side counterpart we said would make the two-ledger
  reconcile real. Prerequisite met — `npx sycee-verify` is published (0.2.0).
- **Next move:** reply to their comment on x402#4116 (chosen over a cold email or a
  new issue) — pick up their own observation that a response-carried receipt cannot
  help when no response arrives. Do not pitch SYCEE as the RFC's receipt scheme.
- **Files:** `reply-x402-4116-vet402.md`, `specs/extensions/refusal-row.md` §12.

---

## Summary

| Party | State | Last action | Value |
|---|---|---|---|
| StelarDigital | 已回（多轮） | their real vector, verified | **highest: a stranger replied with data** |
| holistis | 已回（多轮） | 3rd independent read of our vectors; tsc#19 note posted | technical peer, not customer; gatekeeper of the conformance vectors |
| Book0fEli / Lumière | 已关（completed，对方关闭） | they shipped `responseBasis` + per-member digests from our critique | **only party who changed their product — evidence, not a channel** |
| Sasona | 未回 | one-line question | low; archive after one follow-up |
| Vauban | 未回 | draft expiry pending | standards, time-boxed |
| Brave | 未回 | issue | low; archive |
| predge | 未回 | issue + PR | low; archive |
| ERC-8004 | 未回 | issue | low; archive |
| Counterra | 未回 | issue | low; archive |
| Nirium | 已发（2026-11-24） | issue #21 opened | **highest-value line: a real seller with a real problem** |
| vet402 | 已发（2026-11-24） | x402#4116 reply posted | buyer-side counterpart; publish prerequisite met |
