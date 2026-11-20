# Contributing to SYCEE

Thank you for helping define the `consumed` and `redeem_count` semantics for machine payments.

## What we need most right now

1. **Real-world vectors.** Signed receipts from production agent payment flows, and
   especially the failures: paid and delivered but never used; one proof redeemed against
   several resources; a buyer that ended up not knowing whether it had paid. Constructed
   vectors prove an implementation is self-consistent. They cannot show that the semantics
   describe anything real. See [`conformance/real-world/`](./conformance/real-world).
2. **One adopter.** An implementation outside this repository using these two field names
   is worth more than ten issues proposing them.
3. **More independent implementations.** JavaScript and Python already exist and agree on
   every vector and every level (`packages/core`, `python/sycee_verify`). Go, Rust and Swift
   are missing, and a verifier is small — `python/` is the size to aim at, not a port of the
   whole SDK.
4. **Upstream alignment**, with the current threads:
   - x402-receipts: [`StelarDigital/x402-receipts#6`](https://github.com/StelarDigital/x402-receipts/issues/6)
   - Vauban IETF family: [`vauban-org/x402-stark-receipts-conformance#3`](https://github.com/vauban-org/x402-stark-receipts-conformance/issues/3)
   - ERC-8004 v2: [`erc-8004-contracts#102`](https://github.com/erc-8004/erc-8004-contracts/issues/102)
5. **Protocol mapping PRs** for rails not yet covered (AP2, card-a2a, and others in §9).

Two things are already done and do not need a volunteer: the Chinese README
([`README.zh.md`](./README.zh.md)), and the independent Python verifier
([`python/`](./python)). Duplicating either would be work, but not progress.

## Ground rules

- **Do not break the three red lines.** No fund movement, no scoring, no storing of raw
  payment proof bodies.
- **Additive only.** This spec never redefines an existing field from another standard.
- **Keep packages zero-dependency.** The core validator and signer must run in a clean
  Node environment.
- **Back your claim with data.** If you say a competitor already defines `consumed`, include
  a link to the spec line or source file.

## How to propose a change

1. Open an issue describing the problem with a minimal example.
2. If you can, include the exact VSR before/after your change.
3. Run `npm test` and `npm run vectors` before submitting.
4. Keep language: **normative text in English**; examples and explanatory comments may be
   bilingual.

## Commit messages

- `spec: <what>` for SPEC.md changes
- `schema: <what>` for JSON Schema changes
- `feat(core|middleware|agent-sdk|conformance): <what>` for implementation changes
- `test: <what>` for tests and vectors
- `upstream: <target>` for proposals to other standards

## Code of conduct

Be direct. Be evidence-based. No marketing.
