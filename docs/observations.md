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

The Solana hash in purchase 2 is reproduced as we read it off the screenshot, and it is probably
misread: it contains a space, it reads as lowercase where the others read as mixed case, and it is
one character long. Two independent readings of the same image agree, so we have kept that rather
than a guess at the intended string. A transcription that silently repairs a transaction hash is
worth less than one that says which character it is unsure about.

### What the chains say

The Tempo legs resolve. All three, read from `explore.tempo.xyz` on 2026-11-20:

| leg | status | block | time (UTC) | moves |
|---|---|---|---|---|
| purchase 1 | Success | 46,848,176 | 2026-11-01T01:16:03Z | 0.006 USDC.e → `0x060b…9ff0` |
| purchase 2 | Success | 46,946,855 | 2026-11-01T16:14:21Z | 0.006 USDC.e → `0x060b…9ff0` |
| reverse | Success | 46,974,328 | 2026-11-01T20:24:46Z | 0.00675 USDC.e → `0x5882…4a36` |

Three transfers, all on 1 Nov, in the order the message gives them. In the reverse case the payee
is the same address that paid in the first two. That address, `0x5882…4a36`, is also the
`recipient` in the router's own published Tempo price quote, so the money reached the operator
and not a pass-through. This half of the claim is now **verified**, and does not need trusting.

**The Solana legs do not resolve, and the strongest case is the one that is not a screenshot.**

The repository's own `README.md` states, in the section on `/tempo/buy`:

> That crossing ran on mainnet on 1 November 2026: the payment to us on Tempo was
> `0x1bed21aef1a8f0b9293a838511b5381bcbf670018bfef055fc220b55688deaba`, our payment to the service
> on Solana was
> `HVcNrcGb9RZixMG5SLgp238KR9q1aBM38Q5tyJrt3fucrDmoTkvF6kNNkZfwL9foUWjS5PHMGA5rrU8SSqQ5zF3`, and
> both are on chain to read.

The Tempo half of that sentence is true — we read the block. The Solana half is not readable:
`getSignatureStatuses` with `searchTransactionHistory: true` returns `null`, and `getTransaction`
returns `null`. This is a **64-character signature copied out of a file**, not read off a
screenshot, so misreading is ruled out as an explanation.

Two further observations, recorded because they narrow the space rather than because they settle
it:

- The payee address in the router's published x402 quote, `8HdCdZ1V…12V`, is a valid 32-byte
  address and exists on mainnet, but it is a **System Program account holding only a rent
  balance, with no signature history at all**. A payee that has never been paid is not what one
  expects from a router whose price quote names it, though it is consistent with rent having been
  sent to it separately.
- The router's quote names `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, which is mainnet-beta's
  genesis hash. So "probably another network" does not fit the reverse case: mainnet is what they
  say it is.

That leaves two readings, and we can no longer pick between them on evidence:

1. The transaction exists and our two independent reads of a full public RPC are both wrong. This
   requires the RPC to be lying in a specific direction, which we cannot test from here.
2. The signature is not a mainnet signature, whether by construction or by a field mix-up in
   publishing.

We put this in the issue rather than in a verdict. The question we asked is a question they can
answer in one line, and their answer is worth more than our inference.

**A third reading, for the two purchases.** The message's two Solana hashes are 87 and 88
characters and one contains a space; they were read off a screenshot and may simply be
transcribed wrong by whoever composed the message. Those two we hold loosely. The `README`
signature is a different matter: it came out of a text file, and it is the one that does not
resolve.

**Resolution note (2026-11-20):** an earlier draft of this entry said "two purchases, first agent
ever, both directions work" in one breath. The message supports each of those, but the reverse
direction is a *separate* example and says nothing about the first two. The table below keeps them
apart.

| The claim establishes | The claim does not establish |
|---|---|
| Three Tempo transfers on 2026-11-01, verified on chain | That the Solana legs exist — the README's own signature resolves to nothing |
| The Tempo payee is the operator's address, not a pass-through | That the agent and the seller agree on which attempt settled |
| The buying agent was not known to Sasona and was not directed by them | That either purchase was ever audited by the seller |
| The reverse purchase paid back to the address that paid in the first two | Whether the delivered bytes were consumed |
| A third-party discovery layer (Bazaar) may have routed it | That the discovery happened — "best guess" is their word |
|  | That one payment proof was redeemed exactly once |

The rows are deliberately not balanced. One side has a block height, a timestamp and an amount on
each row; the other side has no chain to read. Averaging the two would produce a summary that
reads as more settled than either half is.

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

**Status:** the Tempo half is verified against the chain; the Solana half is not, and the entry
says which is which. The request for original Solana signatures went to
[`sasona-network/sasona-router#1`](https://github.com/sasona-network/sasona-router/issues/1) on
2026-11-21, phrased as a question about the README rather than a challenge: a `null` from one
node is a weak reason to doubt a payment, and their answer is worth more than our inference. No
reply as of 2026-11-21.

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
  address — it is reproduced as posted and the doubt is flagged. Fixing it makes the quotation
  ours.
- **No verdicts on other people's claims.** Where a claim did not check out, the entry records
  what we asked, what came back, and the readings that remain open. Deciding which reading is
  true is the reader's job and, if it matters, the claimant's.
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
