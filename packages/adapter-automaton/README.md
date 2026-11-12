# @sycee/adapter-automaton

Bind an automaton-sovereign style hash-chained attestation ledger to SYCEE v0.1.

Zero dependencies. Node >= 18. Apache-2.0.

---

## What this is

Your ledger signs entries. Today, 21 of the 33 published entries carry
`dataHash = sha256("{}")` — they attest **that something was signed**, not
**what it was about**.

> "It converts an attestation from 'we signed something' into 'we signed
> something **about this**'" — you, in x402-receipts#6

The entire delta is what `dataHash` covers. This adapter computes `dataHash`
and decides whether a write is authorized. **That is all it does.**

---

## What it does not touch

| Not touched | Why it matters |
|---|---|
| The hash chain | `hash = sha256(prevHash\|timestamp\|dataHash)` stays yours |
| The keyring | rotation, `signedBy: current\|historical`, entry 0's retired key |
| The signatures | ECDSA-P256-SHA256 DER over the ASCII hex of `hash` |
| The payment path | `verifyPayment` calls this adapter, not the reverse |

**Backward compatibility is a tested property, not a promise.** With no
subject, `subjectDataHash()` returns `sha256("{}")` =
`44136fa355b3678a…` — byte-identical to the entries already published. All
33/33 signatures and links stay valid. The first test in the suite asserts this.

---

## Install

`@sycee/adapter-automaton` is not published on npm. Clone this repository and
install the workspaces. The package has no `bin`. `package.json` `exports["."]`
is `./src/index.mjs`, so from the repository root the module is
`packages/adapter-automaton/src/index.mjs`, and a script in this repo imports
the workspace name.

```bash
git clone https://github.com/ruiruii/sycee.git
cd sycee && npm install
# packages are not yet published to npm; use the workspaces in this repo
node --input-type=module -e "import { createAutomatonAdapter } from '@sycee/adapter-automaton'"
```

---

## Minimal wiring

```js
import {
  createAutomatonAdapter,
  deriveIngressSnapshot,
  memoryGuardStore,
} from '@sycee/adapter-automaton';

const gates = createAutomatonAdapter({
  // your existing appendAttestation, unchanged
  append: async (dataHashHex, meta) => appendAttestation({ dataHash: dataHashHex }, meta),

  // G2 — reuse the on-chain check you already run on the payment path
  settlementFor: async (txHash) => {
    const r = await verifyPayment(txHash);
    return { status: r.ok ? 'settled' : 'absent', blockNumber: r.blockNumber };
  },

  store: memoryGuardStore(),          // or your D1 / DO / Redis implementation
  cap:   { perPayerPerWindow: 5, windowMs: 60_000 },   // yours to tune
});

// §3.1 — derive the identity ONCE, at ingress. Both paths resolve this same
// snapshot; neither re-derives it (that is the invariant PR #7 proposes).
const snap = deriveIngressSnapshot({ method, url, params, accepts });

// on the settle path
await gates.attestSettlement(snap, { txHash, resourceId, payer, nonce });

// on the refusal path — server.js:391, where tx_already_used is returned today
await gates.attestRefusal(snap, { txHash, payer, nonce });
```

Two calls, one snapshot. No change to the chain, the keyring, or the signatures.

> Note the API shape is the enforcement. `attestSettlement` / `attestRefusal`
> take a **frozen snapshot**, not the raw request. A path that were refactored to
> re-read `accepts` from live state would not compile — which is the point: the
> prohibition in §3.1 is structural, not advisory.

---

## The two halves are not symmetric

| half | `subject` | buys | does **not** buy |
|---|---|---|---|
| settlement | `txHash` (+`attempt_id`) | **provenance** — binds this payment | a count |
| refusal | **request `attempt_id`** | **a count** — `redeem_count` = entries under that identity | — |

> "txHash-bound entries can never be grouped into a count at all... each attempt
> carries its own tx." — you, x402-receipts#6

Both subject kinds carry the same `attempt_id` (the §3.1 identity, derived once
at ingress), so a settle and its refusals land in the same group. That grouping
is the only reason the count is derivable rather than asserted.

### §3.1 settlement/refusal identity (the invariant this adapter implements)

This adapter is the implementation-side evidence for **x402-receipts PR #7**
(`spec: add §3.1 Reference composition`), authored by @ruiruii. The invariant,
in one line:

> A payment's settlement/refusal identity is **derived once, at ingress, from the
> request as received (canonical form)**, and resolved identically by both the
> settle path and the refusal path, bound to `attempt_id`.
>
> **Prohibition:** *no path re-reads `accepts` after ingress.*

Three consequences fall out of it, and the test suite asserts all three as
runnable acceptance tests (`./test/adapter.test.mjs`, block "§3.1 acceptance
tests"):

| # | Acceptance test (verbatim from PR #7) | What the adapter does |
|---|---|---|
| 1 | One settle + N refusals for the same attempt ⇒ digest and `attempt_id` byte-identical at both sites | `deriveIngressSnapshot` is called once; `attestSettlement` / `attestRefusal` only look it up |
| 2 | Permuting `accepts` without changing terms ⇒ digest unchanged (canonical, not wire) | `referenceComposition` hashes **decoded, named fields** with arrays sorted by content |
| 3 | Changing `amount` mid-attempt ⇒ new fingerprint, and the change surfaces as an announcement event, not a count divergence | a terms change → new identity → separate group; `announceTermsChange()` records the event |

**Why the composition sorts arrays.** `core`'s `canonicalJSON` preserves array
order. A digest that did too would change when `accepts` is reordered on the
wire — silently splitting or merging a `redeem_count`. So the identity is hashed
over the *named* offer fields with array elements sorted by canonical content
(acceptance test 2 fails today against the naive composition; it passes here).

---

## ⚠️ One correction to the threat model, found while implementing it

The threat-model draft specifies **two dedup keys, both "append only if
absent"**:

| key | draft says it bounds |
|---|---|
| `(txHash \| nonce)` | one attempt |
| request fingerprint | one logical request |

**The second one cannot work as written.** A settle and its refusal share a
fingerprint by construction — that sharing is the only reason the group exists.
If the fingerprint key also blocks the append, the refusal never gets written,
the group never exceeds one entry, and `redeem_count` is **pinned at 1
forever**. The guardrail would destroy the property it was introduced to
create.

The two keys are doing different jobs — but not the two jobs the draft says:

| key | actual job | blocks? |
|---|---|---|
| `attemptKey(txHash, nonce)` | idempotency — once-per-attempt | **yes** |
| `requestKey(fingerprint)` | grouping — makes the count derivable | **no** |

Which leaves exactly one bound on ledger growth: **G3**.

The draft already called the per-payer per-window cap *"the backstop, not a
nicety"*. Having implemented it, that is understated. G3 is not the backstop
behind dedup — **it is the only write bound in the design.** Everything else is
idempotency or grouping. That makes the cap parameters the security boundary,
so they are worth choosing deliberately.

Sending this before you implement, per your ask: *"if you send it before we
implement, our objections arrive before the code instead of after."*

---

## Guardrail order

```
G1  idempotency (txHash|nonce)  ──▶  duplicate → stop
G3  per-payer per-window cap    ──▶  over limit → stop
G2  on-chain settlement check   ──▶  not settled → stop
    append  ──▶  group by fingerprint
```

Idempotency first so a duplicate burns neither quota nor an RPC call. The cap
second because it is cheap and must stand **in front of** the RPC — otherwise a
stranger spends your RPC budget at the rate they choose. The on-chain check
last because it is the expensive one.

**G2 requires `settled`, not merely "not absent."** This is safe — and stronger
than it looks — because a `tx_already_used` refusal and an in-flight settlement
are mutually exclusive: a tx cannot be simultaneously already-spent and still
pending. So demanding `settled` rejects forged refusals without ever rejecting
a genuine one.

Every non-`appended` result carries a machine-readable `reason`:
`duplicate_attempt` · `rate_limited` · `not_settled` · `settlement_unverifiable`.

---

## `X-Payment-Settled` mapping

Cited from the thread, **not** from your OpenAPI — which currently documents
`enum: ["true"]` (underselling `queued`) and omits `/v1/verify-payment` from
`paths`. Both defects are yours, disclosed by you.

| wire | status | SYCEE enum |
|---|---|---|
| `true` | 200 | `settled` |
| `queued` | 200 | `in_flight` |
| header absent | 200 | `in_flight` |
| header absent | **402** | `absent` |

The status code is part of the mapping. An absent header means two different
things depending on it, and collapsing them is the false statement SPEC §5.1
exists to prevent — *"not yet observable" is not "not settled."*

---

## What flips in RW-001

Once your origin binds a subject, the read side derives the count straight from
your **published** ledger — no trust in either of us:

```js
import { deriveRedeemCount, contentBindingRatio } from '@sycee/adapter-automaton';

deriveRedeemCount(entries, { fingerprint, attempts });
// → { redeemCount, matched, boundToFingerprint, forms }

contentBindingRatio(entries);
// → { total: 33, empty: 21, bound: 12, ratio: 0.36, emptyIndices: [...] }
```

RW-001's red half asserts `boundToFingerprint === true` at the claimed index.
Today it is `false`, and it should be — the vector is carrying a live gap, not a
citation. When your origin ships the fingerprint half, our weekly CI turns that
half green **on its own**. You will get the run id; nothing is required from you.

---

## Store interface

```js
{
  async claim(key, ttlMs)          → { fresh }            // G1, must be atomic
  async bump(bucket, windowMs, limit) → { count, allowed } // G3
  async group(groupKey, entry)     → { size }              // grouping, never blocks (keyed `${fingerprint}|${window}`)
  async groups(groupKey)           → entry[]               // redeem_count within a window
  async allGroups()                → Map                    // cross-window redeem_count
  recordEvent(ev)                  → { index }              // announcement events
  listEvents()                     → ev[]                   // e.g. "announcement changed mid-attempt"
}
```

⚠️ **Eventually-consistent KV is not safe for `claim()`.** Two concurrent
attempts can each read "absent" and both append — which is exactly the
write-amplification you asked to bound. Use D1 (transaction), a Durable Object,
or Redis `SET NX` for `claim()` in production. `bump()` tolerates loose
consistency; a rare overcount there only makes the cap slightly conservative.

---

## Parameters that are yours to set

| param | note |
|---|---|
| `cap.perPayerPerWindow` / `windowMs` | **the only write bound.** Defaults here are placeholders, not recommendations |
| reference composition | `referenceComposition(request)` — over decoded, named offer fields; arrays sorted by content (§3.1). Must be stable across attempts 1..n and identical across a settle + its refusals |
| `nonce` source | EIP-3009 `nonce` is already single-use |
| RPC + confirmation depth | Base mainnet, 395k+ confirmations observed in RW-001 §1 |

---

## No ask attached

This is authored by SYCEE and published on our side. Adopt it, ignore it,
or rewrite it — on your timeline, with no dependency on this thread. It is a
queued decision for a paid product, and that is the correct frame.

If you spot something wrong in it, the correction is worth more to us than
adoption.
