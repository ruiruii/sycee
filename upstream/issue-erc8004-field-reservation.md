> **Name note.** This was sent when the project was called `gates-spec` (posted as [erc-8004/erc-8004-contracts#102](https://github.com/erc-8004/erc-8004-contracts/issues/102)). The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged.

Following up on [#99](https://github.com/erc-8004/erc-8004-contracts/issues/99) (Predge's grounding primitive) — that thread solves a real problem I want to extend by one layer, not compete with.

## Where #99 lands, and what's one layer below it

#99 proposes making a feedback signal admissible only if it carries a verifiable proof that the rater actually transacted with the ratee. That grounds reputation in *payment*. I think that's right, and the Sybil numbers cited there (73.5% / 59.2% / 90.6% coordinated reviewers) make the case better than I could.

But there's a question *underneath* "did the rater pay?" that no schema currently answers:

> **The payment happened. Did the buyer actually use what it paid for?**

A paid interaction where the result was never referenced downstream is a weak grounding signal compared to one where the result demonstrably entered the buyer's context. And a single payment proof that gets completed N times is a *stronger* Sybil vector than N separate payments, because it's cheaper.

## Two fields worth reserving in v2

If v2 is standardizing x402 payment-proof schemas inside feedback attestations, I'd suggest reserving names for these two now, before the ecosystem forks into `used` / `utilized` / `spent` / `redemption_count` / `reuse_count`:

| Field | Type | Meaning |
|-------|------|---------|
| `agent.spend.result.consumed` | enum `yes` \| `no` \| `unknown` | Was the delivered result referenced in downstream context (another tool call, a prompt, working memory, surfaced to a user)? |
| `agent.spend.payment.redeem_count` | integer ≥ 1 | How many distinct `complete` events were accepted for the same payment proof. |

Companions: `consumed_by` (`string[]` of `task_id` / `message_id` / `conversation_id`), `consumed_at`, `freshness_s`, `redeem_resources`.

Normative guardrails I'd propose, in the spirit of "a rating is cheap to manufacture":

- `unknown` MUST NOT be treated as `yes`. Un-instrumented buyer runtimes get `unknown`, not a free pass.
- `consumed: "yes"` SHOULD carry `consumed_by` evidence — assertion without evidence is exactly the cheap signal #99 is trying to filter out.
- `redeem_count > 1` MUST be recorded, never normalized to `1`.

## Why this matters for the #99 threat model specifically

A Sybil ring that pays once and reuses the same proof across N interactions costs **one payment**, not N. Today that's invisible; `redeem_count` makes it countable. Predge's `outcome-vs-claim` tag intuition is close to this — I'd suggest the tag set also distinguish:

- `x402-paid-interaction` — proof of payment exists (#99's primitive) ✅
- `consumed` — the paid result was actually referenced downstream (this proposal)
- `redeem_count > 1` — one proof, multiple redemptions (a Sybil amplifier)

Those three are separable facts. Conflating the first with the second is how a ring manufactures grounded-looking feedback cheaply.

## What I bring

I published **gates-spec v0.1**, a protocol-agnostic spec for exactly these two fields: https://github.com/ruiruii/gates-spec

- `SPEC.md` + JSON Schema + Ed25519 reference implementation (merchant middleware + agent SDK)
- 9 conformance vectors, CI green on Node 18/20/22, Apache-2.0, zero dependencies
- Same signing shape #99 describes (Ed25519 over canonical bytes), so the two are directly composable

Explicit non-goals, so this isn't misread as a reputation play:

- No score, no rating, no aggregation — this is a **record**, not a judgment.
- No fund movement, no escrow.
- No storage of raw payment proof bodies — hashes only.

## Questions

1. Is a field-reservation issue the right vehicle here, or should this go to the v2 payment-proof schema draft directly?
2. Would the `tag` convention in #99 be willing to carry consumption granularity, or should `consumed` live inside the proof schema rather than as a tag?
3. Any existing name already in flight for these concepts that I should adopt instead of `consumed` / `redeem_count`?

Happy to convert any of this into a PR or a mapping doc if there's appetite. (Independent contributor; not affiliated with any of the teams above.)
