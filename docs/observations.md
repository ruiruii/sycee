# Observations

What other implementations actually do, at a point in time, with links and line numbers.

This file exists because "consumption semantics are missing" is a claim, and a claim needs
evidence that a reader can check without trusting us. Everything below is public: code that
anyone can read, issues anyone can open, statements made in public channels. Where we quote a
statement rather than a file, we say who said it and where, and we do not quote anything that
was said in private.

Two rules for this file.

**It is dated.** Each entry names the commit, tag, or date it was read at. Code moves. An
observation that does not say when it was made is a rumour.

**It is descriptive.** An entry records what an implementation does. It does not say the
implementation is wrong, and it does not score it. Where a behaviour matters to SYCEE, the
entry says which rule it bears on and lets the reader draw the conclusion.

---

## 1. `nirholas/x402-facilitator` — split-leg settlement reported as one boolean

**Read at:** `main`, 2026-11-20. `src/core/facilitator.ts`, 253 lines.

This facilitator supports two settlement schemes. EIP-3009 goes through
`transferWithAuthorization` in one call. EIP-2612 does not, and the code knows it:

```ts
// src/core/facilitator.ts:155-158
if (scheme === 'eip2612' && payment.permit) {
  // EIP-2612: permit() + transferFrom() in two transactions
  const permitHash = await (walletClient as any).writeContract({
```

The permit leg is submitted and waited on before the transfer leg starts (`:172-179`), and then
`transferFrom` is submitted separately (`:184-192`). Both legs are real, and the code comments
say they are two transactions.

The failure path does not preserve that.

```ts
// src/core/facilitator.ts:231-232
metrics.settleFailed.inc({ chainId: String(payment.chainId) });
return { success: false, errorReason: 'Transaction reverted on-chain' };
```

`permitHash` is logged at `:179` and never returned. The response carries one `success` and one
`errorReason`. The outcomes that reach the caller split like this:

| what happened on chain | what the caller is told |
|---|---|
| permit reverted, nonce still unspent | `Transaction reverted on-chain` |
| permit executed, `transferFrom` reverted, nonce spent | `Transaction reverted on-chain` |
| permit executed, `transferFrom` never submitted, or any leg threw | the caught error's `message`, returned as text at `:233-237` |

The middle row is the one that matters. The nonce is spent, the allowance is set, the balance
has not moved, and a retry carrying the same signature will be rejected. A caller that reads
`success: false` and retries is retrying an attempt that can no longer succeed, and the
response gives it no way to tell this case apart from one where retrying is exactly right.
There is a guard that makes this worse rather than better: `inflightNonces` is deleted in the
`finally` block (`:238-239`), so the in-process lock is released whether or not the permit leg
executed.

Bears on: [`specs/extensions/refusal-row.md`](../specs/extensions/refusal-row.md) §15, the drift
state, and the `transfer_leg_failed` reason, whose whole purpose is to name this case. SYCEE does
not require anyone to adopt our vocabulary. It does ask that the distinction be representable,
and in this response it is not.

**Worth recording what changed and what did not.** When we first read this file, `verify()`
accepted a `_requirements` argument and never read it, so a payment valid for *some* resource was
accepted for *this* one. That was reported as
[`#3`](https://github.com/nirholas/x402-facilitator/issues/3) on 2026-05-28 with a full
source-to-sink trace, and the trace was accurate at the time. `main` now reads:

```ts
// src/core/facilitator.ts, verify()
const result = requirements
  ? await verifyPaymentForRequirements(payment, requirements)
  : await verifyPayment(payment);
```

So the binding hole is closed. **The settlement finding above is unchanged by that fix**, and the
two are worth keeping apart: binding and reporting are different questions, and closing one does
not close the other. The file still returns a single boolean for a two-leg settlement, and the
permit hash still does not appear in any response.

That difference also says something about reading code on the internet: the entry above carries a
date because a finding without one ages badly. The commit that closed the binding hole is not in
this entry because we could not reach the commit history when we checked; the quotation is from
`main` as read on 2026-11-20.

**What this repository never provides.** The SDK in [`packages/`](../packages) signs a receipt
after settlement. There is no receipt here, and no notion of what the buyer did with the bytes.
A caller of this facilitator learns whether a transaction landed. It does not learn, in either
direction, whether the delivered result was consumed — which is the question SYCEE was built
around. This is not a criticism of the repository. It is the boundary of what the payment rail
was ever asked to answer, drawn at the place where the answer stops.

---

## 2. Sasona cross-rail settlement — a public claim, not yet a sample

**Source:** `#random`, 2026-11-02 05:35, from *Sasona Developer*. Announced on 2026-11-01.

Quoted in full, because the wording carries most of the information:

> Sasona: a router that lets an x402 agent buy from sellers on other rails.
>
> On 1 Nov, for the first time, an agent we don't know bought through it, twice. Nobody pointed
> it at us; our best guess from its request is that it found the resource in the Bazaar. It can
> only pay x402 on Solana. The service it bought (Judge0 code runs, via Locus) only accepts MPP
> on Tempo.
>
> - Purchase 1: Solana `A2p45Hp6odL1W71qM7dKxwJDznDv1PmejPgoTDPcyReddhRL6pvzLVwM1CbV9j5km2Y6f14mN8hNEBBXK4aeAaB` · Tempo `0xb29cc90edf8013e1834a357cb4eb1bf087d7f76d16b7f1b6e356391ef03bacd6`
> - Purchase 2: Solana `4HtpWc596HnBAoHgUjf4hEgfUjfegDp7sTb5bYRtvBbn uRXBaV4qrsUSbiAzs17MNUQsnFmezVvBEWbvKp52JBSD` · Tempo `0x8bad4587db9c163c93a1029a1df5586f7803016a152972c84a104f56fb865493`
>
> The other direction works too: an MPP payment on Tempo bought a Bazaar resource that only
> settles x402 on Solana (api.mekler.ai, certificate inspection).
>
> - Tempo `0x1bed21aef1a8f0b9293a838511b5381bcbf670018bfef055fc220b55688deaba` · Solana *(hash not visible in the screenshot we hold)*

The Solana hash in purchase 2 is reproduced exactly as posted, including the space — it reads as
lowercase where the other hashes read as mixed case, and it is one character long. We have not
corrected it. A transcription that silently repairs a transaction hash is worth less than one
that flags it, and the original is the claim.

**Resolution note (2026-11-20):** an earlier draft of this entry said "two purchases, first agent
ever, both directions work" in one breath. The message supports each of those, but the reverse
direction is a *separate* example and says nothing about the first two. The table below keeps them
apart.

| The claim establishes | The claim does not establish |
|---|---|
| On 2026-11-01 an agent bought twice through the router, Solana x402 paying into Tempo MPP | That the agent and the seller agree on which attempt settled |
| The buying agent was not known to Sasona and was not directed by them | That either purchase was ever audited by the seller |
| A third-party discovery layer (Bazaar) may have routed it | That the discovery actually happened — "best guess" is their word |
| The reverse pairing (Tempo paying, Solana settling) also ran | Whether the delivered bytes were consumed |
| Chain-level records exist for four of the five legs above | That one payment proof was redeemed exactly once |

Two things in the message are more specific than the popular summary of it, and both point the
same way:

- **`redeem_count` is not in question here.** Each purchase has its own payment, so there is no
  reuse to detect. The claim is about routing, not about redemptions.
- **The agent could not pay the supplier's rail, and the supplier could not accept the agent's.**
  The router resolved that. What it did not produce is any artifact the *agent* can hold saying
  what it got and what it paid — the two records live on two chains, and nothing in this message
  joins them.

A cross-rail path also carries *two* finality semantics that can disagree — Tempo's is
deterministic, Solana's is probabilistic — so "settled" has to name which rail's finality it
means, or it means nothing when read from the other side. SYCEE's `agent.spend.protocol` field
and the per-rail mapping in [SPEC.md](../SPEC.md) §9 exist for that; the field is one string and
the table is longer.

**Status:** we have asked Sasona for a worked failure sample — one attempt, both sides, whatever
it shows — in [`sasona-network/sasona-router#1`](https://github.com/sasona-network/sasona-router/issues/1).
No reply as of 2026-11-20. Until there is one, this entry stays a claim, and we would rather
leave it as one than inflate it into evidence.

---

## 3. holistis — reserved

Two live receipts in `holistis/agent-receipt-verify` would be the first data in this file that we
did not construct ourselves. Both are public in their repository. They are not written up here,
because "the file is public" and "they agreed we cite it" are different permissions and we have
only the first one.

**Status:** awaiting their word. When it arrives, this section gets the receipts, what they show,
and what they do not.

One thing from that repository is already in use, and it is a method rather than a sample, so it is
credited where it is used rather than here: the twin rule in
[`conformance/refusal/README.md`](../conformance/refusal/README.md). A wrong file must be answered
with the value its correct twin records, not merely with a different value — because a checker
that returns a constant differs from every wrong file, and passes.

---

## 4. What is not in here

- **No private conversations.** If it was a DM, it does not go in this file, even when we have
  permission to quote it. A public channel is quotable; the sender chose the audience.
- **No repaired quotations.** If a quoted string looks wrong — a space in a hash, a lowercase
  address — it is reproduced as posted and flagged. Fixing it makes the quotation ours.
- **No third-party scores.** No stars, no adoption counts, no "maturity" columns. Those invite
  an argument about reputation and this file is about code.
- **No conclusions.** An entry says what an implementation does. Whether SYCEE's answer is
  better is a separate claim, made in [README.md](../README.md), and it should have to stand
  on the evidence rather than be smuggled in beside it.

## Adding an entry

Keep the shape: source, date or commit, the smallest quotation that carries the point, what it
bears on, and what it does not establish. If the source is a person rather than a file, say
where they said it and whether they have been asked anything. If the finding is disputed, say
so in the entry rather than in a footnote.
