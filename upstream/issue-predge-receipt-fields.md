> **Name note.** This was sent when the project was called `gates-spec` (posted as [predgeAI/erc8004-outcome-validator#13](https://github.com/predgeAI/erc8004-outcome-validator/issues/13)). The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged.

I read through this repo after finding it via [erc-8004/erc-8004-contracts#99](https://github.com/erc-8004/erc-8004-contracts/issues/99). Two things made me want to reach out:

1. You signed-attest **ed25519 over canonical JSON** and bind `responseHash = keccak256(signed bytes)` on-chain. That's the same construction I standardize on.
2. You have a **`PredgeSettlement` pay-per-call receipt** contract. That's the layer I work on.

I want to be precise about scope first: your domain is prediction-market settlement risk (Polymarket disputes, oracle outcomes), mine is agent-to-agent payment semantics. Those are different problems. But the **receipt layer underneath them is shared**, and that's where I think there's a cheap, concrete win for you.

## The two fields

I published **gates-spec v0.1** (https://github.com/ruiruii/gates-spec) — a protocol-agnostic spec for exactly two things that no receipt schema currently defines:

| Field | Type | Meaning |
|-------|------|---------|
| `agent.spend.result.consumed` | `yes` \| `no` \| `unknown` | Was the delivered result actually referenced downstream — another tool call, a prompt, working memory, surfaced to a user? |
| `agent.spend.payment.redeem_count` | integer ≥ 1 | How many distinct `complete` events were accepted for the same payment proof. |

Companions: `consumed_by` (`string[]`), `consumed_at`, `freshness_s`, `redeem_resources`.

## Why this is relevant to Predge specifically

Your `PredgeSettlement` receipt is a **pay-per-call** receipt. Two questions it currently can't answer, and I think you'd want it to:

- **Was the result used?** An agent can pay for a settlement-risk record, receive it, and never act on it — context budget exhausted, a downstream step discarded it. That's real cost with zero downstream effect. For a product whose whole thesis is "verifiable evidence that someone acted on something," consumption is arguably the missing half of the claim.
- **Was one proof redeemed more than once?** x402's in-flight dedup stops *concurrent* replay; it doesn't record *sequential* reuse across separate requests. A single proof completed N times is cheap to manufacture.

Concretely: `redeem_count` is a Sybil amplifier detector. That's directly adjacent to #99's thesis that feedback signals should be grounded in provable transactions — a ring that pays once and reuses the proof N times costs one payment, not N.

## Why I'm proposing this to you and not just building it

You already sign ed25519 over canonical JSON and already bind the hash on-chain. Adding these two fields is:

- two optional keys in your receipt envelope,
- no change to your contracts,
- no change to your signing scheme,
- backward compatible (absent = no claim made; `unknown` MUST NOT be treated as `yes`).

## What I'd offer

- A **PR** or a patch against whatever your receipt object looks like, if you point me at it (I looked at `grounded-feedback/` and `monad/` but didn't want to guess which is canonical).
- **Test vectors** — I ship 9 signed conformance vectors and a zero-dependency verifier; if your `verify-test-vectors.mjs` pipeline can consume a second vector set, cross-verification is a few lines.

## Honest context

- I'm an independent contributor (Sycee); not affiliated with any of the teams in this thread.
- Revenue today is $0 on my side too, so this isn't a sales pitch — it's an attempt to avoid two projects inventing `used` / `utilized` / `redemption_count` for the same concept.
- If you already have names in flight for these, tell me and I'll adopt yours instead.

Either way, the repo is worth a look if you're building receipts — your ed25519/canonical-JSON/responseHash stack is the closest thing I've found to what I'm specifying.
