> **Name note.** This was sent when the project was called `gates-spec` (posted as [brave/bx402#141](https://github.com/brave/bx402/issues/141)). The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged.

I read [#102](https://github.com/brave/bx402/issues/102) (concurrent replay of one x402 payment → N unpaid upstream searches) and the fix that closed it. Nice catch, and the MPP-vs-x402 asymmetry you documented — mppx's pre-broadcast `tryClaimHash` vs. x402's stateless verify→search→settle — is the most precise writeup of this gap I've seen.

I'm raising a follow-up rather than reopening it, because I think the fix and what I'm proposing solve **different halves** of the problem.

## Your fix is prevention. The other half is evidence.

The fix claims a canonical hash of the payment payload before `verify` and refuses duplicates — an in-memory claim store, mirroring mppx. That **stops** the duplicate search. Good.

Two properties it doesn't give you, by design:

1. **It's an in-memory claim across the verify→settle window.** It answers "is this proof currently in flight?" It doesn't answer, after the fact, "how many times did this proof get accepted?" Across a process restart, or across instances behind a load balancer, the claim store is per-instance. A proof replayed slowly — sequentially, below the concurrency window — isn't prevented, and leaves no trace.
2. **It produces no auditable artifact.** After the fact you can't show anyone "this proof was completed 1 time" (or 3). For quota disputes with an upstream provider, or for enterprise buyers who need to evidence that paid calls were actually consumed, the absence of that record is the problem — not the duplicate itself.

## What I'd add: `redeem_count` and `consumed`

I published **gates-spec v0.1** (https://github.com/ruiruii/gates-spec), a protocol-agnostic spec for two fields:

| Field | Meaning |
|-------|---------|
| `payment.redeem_count` | How many distinct `complete` events were accepted for the same `proof_hash`. |
| `payment.redeem_resources` | Which resources that proof was completed against. |
| `result.consumed` | `yes` \| `no` \| `unknown` — was the delivered result actually referenced downstream? |

The middleware does the counting itself, so you'd get it for free alongside your existing dedup rather than instead of it:

```js
import { createGates, memoryStore } from '@gates-spec/middleware';

const gates = createGates({
  resourceId: 'res/v1/web/search',
  protocol: 'x402',
  publicKey, privateKey,
  store: memoryStore(), // or a shared Redis store for multi-instance
});

app.all('/res/v1/web/search', gates.guard(handle));
// emits x-gates-redeem-count and a signed x-gates-receipt on every completion
```

With a shared store, `redeem_count` also closes the multi-instance hole that a per-process claim store can't.

## Why this maps onto your metrics story

You already have the exact signal: `bx402_upstream_requests` vs `bx402_payments{outcome="settled"}`. `redeem_count` is that same ratio **per proof**, signed, portable, and checkable offline by whoever audits the bill. The bug signature you described becomes a field you can hand to an upstream provider.

And `consumed` is the adjacent question your metrics probably can't see: of the searches that *did* settle, how many results were actually consumed by the calling agent? Delivered-but-never-used is still a real upstream call.

## Not a replacement

To be clear: your dedup fix is the right runtime guard, and I'm not proposing you swap it. I'm proposing an audit layer next to it. Prevention stops the waste; evidence settles the dispute.

## Offer

- Reference implementation is Apache-2.0, zero dependencies, Node ≥18, CI green, 9 conformance vectors.
- Happy to open a PR wiring it into `src/x402.ts handle()` alongside the existing claim — including a shared-store variant if you run multi-instance.
- Or if you'd rather just take the two field names and emit them in your own envelope, that works too; the spec is meant to be adopted piecemeal.

(Independent contributor, Sycee. Not affiliated with Brave.)
