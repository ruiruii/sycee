# Changelog

## 0.2.0 — first npm release (pending publish)

The verifier is now installable: `npx sycee-verify receipt.json` runs the same
checker as a checkout, with no clone and no second copy of the rules.

- New publishable package `sycee-verify` (`packages/cli/`): a thin `bin` wrapper
  whose only dependency is `@sycee/core@^0.2.0`. `bin/sycee-verify.mjs` becomes a
  local forwarder so existing repo paths are unchanged.
- Every `@sycee/*` package moves `0.1.0 → 0.2.0`, matching SPEC/refusal v0.2.
  Internal dependencies move from `*` to `^0.2.0`. The VSR envelope stays
  `sycee/v0.1` — its wire field set did not change.
- Merchant staging note and both READMEs now lead with the `npx` command; the
  "not yet shipped" notice is gone.
- Publish order: `@sycee/core` first, then `sycee-verify`. Verified from a clean
  directory: single file 1/1, full vector directory 76/76.

## Unreleased

### The version is now v0.2, in the title and in the refusal rows

The identity change was announced as "breaking, v0.1 → v0.2" while the title and the code still
said v0.1. A verifier reading the spec could not tell which identity recipe a `sycee/refusal/v0.1`
row used, which is exactly the failure the version exists to prevent.

- SPEC title and status are now v0.2, and the registry lists v0.2.
- `REFUSAL_SCHEMA_VERSION` is `sycee/refusal/v0.2`; the prose reader and its tests follow.
- refusal-row §4 names `sycee/refusal/v0.2`; §11 no longer describes the pre-§3.1 recipe
  (payload + requirements + a presentation suffix) and instead documents the separator
  collision the current recipe avoids.
- The VSR envelope schema stays `sycee/v0.1`: its field set did not change, and its
  `request_fingerprint` has always been an opaque digest the verifier does not recompute.

### The examples carry the payment terms the identity needs

The identity change made `payTo` a required member, and `createGates` fails loudly on a paid
request when it is absent. Four entry points were still written without it, so `npm run demo`,
`npm run demo:bilateral`, the minimal pair, and the Express quickstart all threw `payTo_required`
on their first paid call while CI stayed green — `npm test` does not run the examples.

- `examples/walkthrough.mjs`, `examples/bilateral-consumption.mjs`, `examples/minimal-server.mjs`
  and `examples/quickstart-express/server.mjs` now pass `payTo`, `network` and `scheme` to
  `createGates`, matching the terms the README's merchant snippet already names.
- README (both languages) and `examples/README.md` now point at `buyer-reconcile.mjs` and
  `bin/sycee-doctor.mjs`, and the quickstart README's 402 body matches what the challenge emits.
- `package.json`: `test:examples` runs the four self-contained entry-point scripts, so the
  breakage above can be reproduced with one command.

### A divergence says which member, not just that there is one

Two keys that differ tell a buyer to contact the seller and a seller to ask for logs. Neither of those is a fix, and the actual cause is usually one member: a proxy that terminated TLS, or one that stripped a path prefix. The members are not secret, so there was no reason to make someone guess.

- SPEC §10, *Locating a divergence*: a response carrying an attempt identity SHOULD publish `x-sycee-members` — base64url JSON, §3.1's members, each as `sha256:<64 hex>` over its composed value. A member that can hold a credential (`query`) MUST be published as `null`, not digested: a short query is recoverable from its digest, and the buyer already knows what it sent. Refusal responses carry it too, because a refusal is what gets investigated.
- The header is a diagnostic, not a second identity. The buyer still composes its key from the request and the challenge, and MUST NOT adopt a published value. Publishing does not weaken that: the buyer's key exists before the response arrives.
- `@sycee/agent-sdk`: each entry carries `divergedAt`, the members whose digests disagree, with both sides' values. `reconcile()` adds `summary.divergences_by_member` and `summary.explained`, grouping by member rather than by attempt — a hundred unmatched rows that all differ on `origin` are one configuration error. It names the member and stops; which side should change is a deployment question.
- `bin/sycee-doctor.mjs`: runs a request through a simulated misconfiguration (`--rewrite proto|path|host|none`) and prints what a buyer can conclude from the response alone.
- Fixed while testing it: the refusal path did not set the header, so the calls an operator opens first were the only ones that could not be diagnosed.
- Tests 240 → 248.

### The buyer's half is computed, not copied

The identity change made the two sides able to name the same attempt. Nothing used that: the 402 challenge did not carry the payment members the buyer needs, the buyer composed nothing, and the agent SDK dropped the seller's signed refusal on the floor. The result was a ledger with one side filled in, which is the state the whole record exists to leave behind.

- SPEC §3.1.1: a 402 challenge MUST carry `scheme`, `network`, `payTo`, `asset` and `amount` in each `accepts[]` element, and the buyer MUST compose the identity locally rather than adopt one the seller states. A stated identity makes every comparison pass by construction.
- `@sycee/middleware`: `paymentRequirements()` is the single source for those five members. The challenge and `identityFor()` read it, so the value the buyer is told and the value the seller records cannot drift apart. Before this they came from `config`, and the challenge published none of them.
- `origin` is no longer hard-coded to `https`. It reads `X-Forwarded-Proto` / `X-Forwarded-Host`, then `req.socket.encrypted`, then `http`. A buyer on `http://localhost` and a seller behind an unconfigured proxy previously computed different identities for the same request, and neither could tell. The mismatch is now visible as `only_buyer` / `only_seller` in reconciliation instead of silent.
- `@sycee/agent-sdk`: `spendFetch` keeps the 402 body's `refusal_receipt` (the seller's signed claim) and records `attemptIdentity`, `observedHttp` and `decision` per entry. `identityFrom()` reports `challenge_missing_*` rather than composing a key from absent members.
- `@sycee/agent-sdk`: `reconcile({ agentEntries, merchantRows })` pairs the two ledgers per identity and presentation, and returns `match`, `status_disagrees`, `only_buyer`, `only_seller`, plus `unidentified` for attempts that had no key. It does not decide which side is right: the buyer cannot see settlement and the seller cannot see what arrived.
- `@sycee/middleware`: `presentation` is counted per attempt identity, not per proof. Reusing `redeem_count` for it gave two purchases of one URL — different proofs, same request — `presentation: 1` on both rows, which is one key with one ordinal and therefore a contradiction the ledger cannot keep. A refusal under a second proof was dropped on the way in. `redeem_count` still counts per proof; the two questions are different and now have different counters.
- Tests 231 → 240, including an end-to-end pair where a buyer and a middleware that never share state arrive at the same identity, and a settled call plus its refused replay reconcile to 2/2. `examples/buyer-reconcile.mjs` prints the four-attempt run: 4/4 match, both refusals present on both sides.

### The identity is now x402's identity (breaking, v0.1 → v0.2)

`attempt_identity` was `sha256(JCS({spec, payload: sha256(payload), requirements: sha256(requirements), presentation}))`. Nobody outside this repository could recompute that value, so no row could ever be matched to an x402 settlement — which is the one thing the row exists for. Nirium's 2026-11-17 update is the same failure from the other side: 37 on-chain payments against 39 logged receipts, totals that do not agree, and their own note that one-to-one matching needs the settlement hash on the paid path.

- `attempt_identity` is now the composition in SPEC §3.1, which is x402 §5.5's ingress identity under a fixed member order: `sha256("sycee/attempt/v1" | method | origin | path | query | payTo | asset | network | amount | scheme)`. Written as an order, not a sorted-key object, so a reader can recompute it from the page.
- `presentation` moved out of the hash and onto the row as `agent.spend.refusal.presentation` (1-based). A settled attempt and its refused replay now share one identity and differ in that field, which is what §5's repeat reasons describe.
- SPEC §3.1, SPEC §5.5.4 and refusal-row §4 held three different definitions of "the identity". They now hold one, and `docs-parity` compares the member list and the domain tag across both documents and the code on every run.
- `mergeRow` no longer reports a refusal as a contradiction of an earlier acceptance when the two rows are different presentations. Before this change a replay refusal was written, signed, sent to the buyer, and then dropped from the ledger as a conflict while the buyer held a 402.
- A member containing `|` is refused rather than escaped; an empty query and an absent query are one attempt; a paid route with no `payTo` has no identity and now fails loudly instead of composing one from an empty string.
- The vectors are unaffected: they carry `attempt_identity` as a literal, not a computed value. Tests 231.

- §15.4: the leg table no longer uses an em dash. A bare cell is a required leg; a bracketed cell is optional to record and bounded in value. Every `transfer` cell was rewritten, and `internal_error` / `facilitator_timeout` now admit only `not_reached` or `unknown` — the two positions §15.3 assigns them. Recording `transfer: failed` under `internal_error` is rejected with `leg_contradicts_reason`; that row used to be constructible, and the earlier repair narrowed the authorization leg instead of fixing the cell, which made the row legal without making it true.
- §15.4 L4: the legs are ordered. A transfer status other than `not_reached` says the transfer was submitted, which requires the authorization leg to have run, so such a row may not record the authorization as `not_reached` or `failed`.
- `@sycee/core`: `BOUNDED_LEG_STATUS` alongside `REQUIRED_LEG_STATUS`; `legSupport` checks both and then the order rule.
- §5, second table: `settlementCheck` enforces the settlement state each repeat reason claims. `replay_already_settled` + `not_submitted`, `replay_in_flight` + `settled` and `could_not_compare` + `settled` are rejected with `settlement_contradicts_reason`. The rule was in the prose and in the prose reader, and the constructor did not run it.
- §15.4 L6: `legSettlementCheck` pairs a recorded leg with the settlement state it permits. `settled` appears only beside `executed`; a leg recorded as `failed`, `not_reached` or `unknown` cannot sit beside a settlement that landed or is in flight. Rejected with `settlement_contradicts_leg`.
- §15.4 L6 includes `authorization`, not only `transfer`. The earlier argument for leaving it out — an allowance approved once lets a facilitator call `transferFrom` without re-running `permit` — describes an accepted attempt, and an accepted row records no legs. What the exception left standing was four constructible refusals (`risk_policy_rejected`, `commercial_refusal`, `malformed_payload`, `authorization_expired`) recording `settled` beside an authorization the row says never ran.
- Conformance: 61 → 76 known-answer files (23 accepted with a wrong twin, 30 rejected with an accepted near miss). `legs.test.mjs` 18 → 23 tests, seven mutants; 228 tests overall.

- `examples/near-anchor`: a NEAR testnet contract that anchors SYCEE receipt hashes. It stores hashes only. No scoring, no custody, no fund movement. Deployed as `sycee-anchor.testnet` from commit `01b4e419` (wasm 159146 bytes). The sample receipt is anchored at block 277456711. `npm run demo:e2e` and `npm run demo:security` also ran on testnet (simulated payment; restricted key `ed25519:7G1L5eMc5pKCJcVNbHvv68j1THA6bxc9QDFg7sFN4Qjy`). The mainnet payout account is `locallemon5213.near`. The public demo is https://ruiruii.github.io/sycee/ (deployed from main). The demo video (2-min, posted as a reply under the demo post) is https://x.com/aking_z/status/2121175474265313681. The demo post on X is https://x.com/aking_z/status/2121175201778143394.

## 0.1.0

First release of the reference repository for SPEC v0.1.

- SPEC v0.1: agent spend semantics for consumption and redemption counts, and the Verifiable Spend Receipt (VSR) envelope.
- `@sycee/core`: canonical JSON, hashing, and Ed25519 `signVSR` / `verifyVSR`.
- Packages: `@sycee/middleware`, `@sycee/agent-sdk`, `@sycee/conformance`, `@sycee/adapter-automaton`, and `@sycee/probe`.
- Conformance vectors, the evidence-layer probe, and published reports.
