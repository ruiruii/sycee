# Hosted evidence service — where the line is

This page exists because "open core with a paid layer" is a claim that has to be checkable,
not a vibe. Everything below the line is in this repository under Apache-2.0 and stays
there. Everything above it is a service that is in pilot and is **not** implemented here.

## Below the line: open, complete, no account

| Capability | Where | Can you use it without us? |
|---|---|---|
| Receipt construction, signing, canonical JSON | `packages/core` | Yes |
| Merchant middleware, redemption counting | `packages/middleware` | Yes |
| Agent runtime SDK, consumption recording | `packages/agent-sdk` | Yes |
| Offline verification, bilateral linking | `verifyVSR`, `linkReceipts` | Yes |
| Conformance vectors and validator | `conformance/`, `packages/conformance` | Yes |
| Optional anchor contract and scripts | `examples/near-anchor/` | Yes |
| Specification | `SPEC.md` | Yes |

The open packages are not crippled versions of the service. A merchant and an agent can
produce, exchange, and verify L2 bilateral receipts with nothing but this repository, and
nothing in the format is withheld for the paid tier.

## Above the line: what the hosted service would do

Only three things, all of which need someone to stay awake:

1. **Keep a copy.** Store already-signed receipts so neither side depends on the other's
   disk surviving.
2. **Serve verification.** A read-only endpoint that returns whether a receipt verifies
   and whether its twin exists, for parties who do not want to run the checker.
3. **Anchor on request.** Write the receipt fingerprint to a public timestamp layer and
   return the transaction reference.

Phase 1 is `redeem_count` only: the service sees hashes and counters, not consumption
claims. Agent-signed `consumed` joins later, and only if the pilot shows it is wanted.

## What it never does

- **No custody.** No balances, no escrow, no transfer. The service has no key that can
  move funds.
- **No raw payment proofs.** Receipts carry `sha256(proof)`; the proof itself never
  reaches the service, and the spec forbids storing it.
- **No scoring.** No trust, credit, reputation, or ranking. Not "not yet" — not in the
  product.
- **No take-it-or-leave-it.** Verification is specified, and the checker is open source.
  A customer who leaves can reproduce every verdict offline with this repository.

## Status, honestly

- It is in **pilot with partners**, not a live product.
- There is **no public pricing**; terms are set with pilot partners.
- It is **not built in this repository**, and this page is not a roadmap promise. If it
  never ships, the open layer is unaffected.

## If you would rather not use it

Run the checker yourself:

```bash
npm run verify                        # the conformance vectors
node examples/refusal-walkthrough.mjs # verify a refusal claim offline
```

Store the receipts wherever you like — a database, an object store, a git repository.
They are self-contained: signature, hashes, and the fields needed to re-verify. The only
thing a third party adds is uptime.
