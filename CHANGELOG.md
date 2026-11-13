# Changelog

## Unreleased

- `examples/near-anchor`: a NEAR testnet contract that anchors SYCEE receipt hashes. It stores hashes only. No scoring, no custody, no fund movement. Deployed as `sycee-anchor.testnet` from commit `01b4e419` (wasm 159146 bytes). The sample receipt is anchored at block 277456711. `npm run demo:e2e` and `npm run demo:security` also ran on testnet (simulated payment; restricted key `ed25519:7G1L5eMc5pKCJcVNbHvv68j1THA6bxc9QDFg7sFN4Qjy`). The mainnet payout account is `locallemon5213.near`. The public demo is https://ruiruii.github.io/sycee/ (deployed from main). The demo video (2-min, posted as a reply under the demo post) is https://x.com/aking_z/status/2121175474265313681. The demo post on X is https://x.com/aking_z/status/2121175201778143394.

## 0.1.0

First release of the reference repository for SPEC v0.1.

- SPEC v0.1: agent spend semantics for consumption and redemption counts, and the Verifiable Spend Receipt (VSR) envelope.
- `@sycee/core`: canonical JSON, hashing, and Ed25519 `signVSR` / `verifyVSR`.
- Packages: `@sycee/middleware`, `@sycee/agent-sdk`, `@sycee/conformance`, `@sycee/adapter-automaton`, and `@sycee/probe`.
- Conformance vectors, the evidence-layer probe, and published reports.
