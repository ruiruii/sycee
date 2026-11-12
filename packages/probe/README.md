# @sycee/probe

**Evidence-layer probe for x402 (and protocol-agnostic) payment ledgers.**

`gates-probe` runs a battery of *coverage predicates* against any public ledger and
emits a structured, optionally **signed**, report. It answers one question per
predicate: *does the evidence this ledger publishes cover this property?* — it never
scores the implementer. That is the whole point: the tool measures, it does not grade.

It is the standalone CLI form of the RW-001 verification logic: instead of one
hard-coded target (automaton-sovereign + one Base tx), it takes any origin and a
fingerprint and runs the same predicate set.

## Install

`@sycee/probe` is not published on npm. Clone this repository and install the
workspaces, then run the checked-in bin. `package.json` maps the `gates-probe`
command to `bin/gates-probe.mjs`, which from the repository root is
`packages/probe/bin/gates-probe.mjs`.

```bash
git clone https://github.com/ruiruii/sycee.git
cd sycee && npm install
# packages are not yet published to npm; use the workspaces in this repo
node packages/probe/bin/gates-probe.mjs
```

With no command, that prints usage and exits 0. A real run is `probe`, `verify`, or `batch`, as below.

## Quick start

Commands below are run from the repository root.

```bash
# Live probe of a public ledger
node packages/probe/bin/gates-probe.mjs probe https://api.automaton-sovereign.workers.dev

# Machine-readable output
node packages/probe/bin/gates-probe.mjs probe https://example.org --json --out report.json

# Exercise the settlement-binding half (needs the request fingerprint)
node packages/probe/bin/gates-probe.mjs probe https://example.org --fingerprint sha256:<64hex> --attempts '[{"txHash":"0x…","resourceId":"search.v1","settled":true}]'

# Offline: analyze a captured ledger file
node packages/probe/bin/gates-probe.mjs probe --from-file ./ledger.json

# Sign the report (your observer key) and verify it later
node packages/probe/bin/gates-probe.mjs probe https://example.org --sign --key ./observer.json --out report.signed.json
node packages/probe/bin/gates-probe.mjs verify ./report.signed.json

# Batch: probe every URL in a newline-separated file
node packages/probe/bin/gates-probe.mjs batch --list ./endpoints.txt --json
```

## Predicates

Each predicate returns a `status` and a `level`:

| status    | meaning                                                            |
|-----------|--------------------------------------------------------------------|
| `pass`    | the predicate holds                                                |
| `gap`     | a known, expected-to-be-missing gap (the point of a known-gap vector) |
| `fail`    | should hold but does not — a real defect                           |
| `pending` | needs information this run did not have (e.g. no fingerprint)       |
| `info`    | informational, no pass/fail semantics                             |

`level` is the evidence-layer maturity the predicate speaks to — **not a grade**:
`L0` = payment only, `L1` = a consumption predicate is present, `L2` = bilaterally verifiable.

| id                                | level | what it checks                                                              |
|-----------------------------------|-------|-----------------------------------------------------------------------------|
| `ledger.hashIntegrity`            | L0    | every entry's hash recomputes from `(prevHash, timestamp, dataHash)`         |
| `ledger.chainContinuity`          | L0    | `prevHash` links each entry to its predecessor; indices contiguous           |
| `keyring.historyAware`            | L0    | verifier resolves keys by `id` against current + history (not current-only) |
| `evidence.contentBinding`         | L0/L1 | entries carry a real payload, not `sha256("{}")`                            |
| `evidence.settlementLinkage`      | L1/L2 | an entry binds this payment via a gates subject (needs fingerprint)          |
| `evidence.redeemCountDerivable`   | L0/L1 | counts are *derived* from the ledger, not *asserted*                         |
| `evidence.settlementTrivalued`    | L1    | a three-value settlement predicate (`settled`/`in_flight`/`absent`) is exposed |

`evidence.contentBinding` is the measurement behind *"64% of attestations sign an
empty object"*: an entry whose `dataHash` is `sha256("{}")` proves "we signed
something", not "we signed something about this payment".

## Signing & verification

`--sign` produces a signed envelope `{ report, signature, signer }`. With `--key`,
the key in the JSON file (`{ "privateKey": "ed25519-priv:<base64url>" }`) is used.
Without `--key`, a throwaway key is generated and printed — useful for a demo, but
the signature is not reproducible across runs.

`verify` checks the Ed25519 signature over the canonical report and exits non-zero
on any mismatch (tampering, field edits, wrong key). The signed report is itself a
verifiable artifact — the "we measured, here is the record" posture.

## Use as a library

```js
import { probe, signReport, verifyReport } from '@sycee/probe';

const report = await probe({ target: 'https://example.org', fingerprint, attempts });
const signed = signReport(report, privateKeyRef);
console.log(verifyReport(signed).valid); // true
```

`probe` accepts `fromFile` for offline analysis and an injectable `fetchImpl` /
`loadFile` for testing.

## Relationship to RW-001

`conformance/real-world/verify-rw001.mjs` is the *concrete instance* of this tool:
automaton-sovereign + one Base mainnet tx, run weekly in CI. `gates-probe` is the
generalization — point it at any origin and it runs the same predicate set. When the
origin publishes a request fingerprint, the settlement-binding half flips from
`pending` to `pass` on its own, with no code change.
