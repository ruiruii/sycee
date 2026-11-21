# Changelog

## Unreleased

- §15.4: the leg table no longer uses an em dash. A bare cell is a required leg; a bracketed cell is optional to record and bounded in value. Every `transfer` cell was rewritten, and `internal_error` / `facilitator_timeout` now admit only `not_reached` or `unknown` — the two positions §15.3 assigns them. Recording `transfer: failed` under `internal_error` is rejected with `leg_contradicts_reason`; that row used to be constructible, and the earlier repair narrowed the authorization leg instead of fixing the cell, which made the row legal without making it true.
- §15.4 L4: the legs are ordered. A transfer status other than `not_reached` says the transfer was submitted, which requires the authorization leg to have run, so such a row may not record the authorization as `not_reached` or `failed`.
- `@sycee/core`: `BOUNDED_LEG_STATUS` alongside `REQUIRED_LEG_STATUS`; `legSupport` checks both and then the order rule.
- Conformance: 61 → 67 known-answer files (22 accepted with a wrong twin, 23 rejected with an accepted near miss). `legs.test.mjs` 13 → 18 tests, six mutants.

- `examples/near-anchor`: a NEAR testnet contract that anchors SYCEE receipt hashes. It stores hashes only. No scoring, no custody, no fund movement. Deployed as `sycee-anchor.testnet` from commit `01b4e419` (wasm 159146 bytes). The sample receipt is anchored at block 277456711. `npm run demo:e2e` and `npm run demo:security` also ran on testnet (simulated payment; restricted key `ed25519:7G1L5eMc5pKCJcVNbHvv68j1THA6bxc9QDFg7sFN4Qjy`). The mainnet payout account is `locallemon5213.near`. The public demo is https://ruiruii.github.io/sycee/ (deployed from main). The demo video (2-min, posted as a reply under the demo post) is https://x.com/aking_z/status/2121175474265313681. The demo post on X is https://x.com/aking_z/status/2121175201778143394.

## 0.1.0

First release of the reference repository for SPEC v0.1.

- SPEC v0.1: agent spend semantics for consumption and redemption counts, and the Verifiable Spend Receipt (VSR) envelope.
- `@sycee/core`: canonical JSON, hashing, and Ed25519 `signVSR` / `verifyVSR`.
- Packages: `@sycee/middleware`, `@sycee/agent-sdk`, `@sycee/conformance`, `@sycee/adapter-automaton`, and `@sycee/probe`.
- Conformance vectors, the evidence-layer probe, and published reports.
