> **Name note.** This was sent when the project was called `gates-spec` (posted as [billiondollarapps/counterra#10](https://github.com/billiondollarapps/counterra/issues/10)). The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged.

# Outreach — Counterra (demand side)

Posted 2026-10-09 12:52 UTC as issue #10:
https://github.com/billiondollarapps/counterra/issues/10

**Why this one matters.** Counterra is the first party we have found that is *not* a
supplier. It is open-source accounting for x402 spend — decoding facilitator settlements on
Base into per-agent journal entries with QuickBooks/Xero export. Repo pushed 2026-10-09
12:14 (same day), 9 open issues, all hard accounting: EN 16931 e-invoices, EU CAAP-1
(ECB rate at payment date, reverse-charge lines), ERP export formats, ERC-8021 attribution.

They are the demand side we had zero evidence for. `consumed` is the last cell their journal
line cannot fill; `redeem_count > 1` is, for them, a double-entry defect (one economic
event, two journal entries), not a payments curiosity.

---

## Title

Two things a journal line still can't say: was the result used, and was one payment redeemed twice

## Body

Reading #2 and the issue list here — the EN 16931 and CAAP-1 work especially — this looks
like the only project in the x402 space treating receipts as *accounting input* rather than
as a debugging artifact. That is why I am writing.

In x402-receipts#2 you framed the gap precisely: the journal line today says *"0.005 USDC to
blockrun.ai"*, and with a receipt it could say *"0.005 USDC to blockrun.ai for GET /signal,
HTTP 200"*. Two accounting questions are still unanswered by that line. Both are cheap to
add, and I think you are the party that cares.

**1. Was the result actually used?**

`HTTP 200` is delivery, not consumption. An agent can pay, receive, and never reference the
result — context budget exhausted, a downstream step discarded it. That is spend with zero
downstream effect, and it is the first thing an auditor asks about.

The field is `consumed = yes | no | unknown`, with one rule that matters: **only the buyer
runtime may sign it**. A seller writing `consumed` is unfalsifiable self-report, which is
exactly what the delivery/settlement split was introduced to prevent. The default is
`unknown`, never `no` — absence of a downstream reference is not evidence of idle spend.

**2. Was one payment redeemed twice?**

`redeem_count` = redemption *attempts* for one payment proof, observed by the seller. It has
to be attempts, not completions: under `exact` the EIP-3009 nonce is single-use, so a
*completed* second redemption is structurally impossible — what actually happens is a
refusal (`402 payment_invalid / reason: tx_already_used`). A field defined as "accepted"
would sit at `1` forever and read as broken rather than as evidence.

For you this is a double-entry problem, not a payments problem: one economic event, two
journal entries. `redeem_count > 1` is the flag, and unlike a dedupe guard it leaves a
signed trace that survives a process restart and can be checked offline during audit.

**Where this came from.** gates-spec — https://github.com/ruiruii/gates-spec — Apache-2.0,
zero dependencies, 12 byte-reproducible conformance vectors. The settlement half came out of
a long thread with a production x402 seller running Base mainnet (x402-receipts#6); they
contributed a real settled mainnet USDC payment as a conformance vector, and their
`tx_already_used` refusal is what convinced me the counter has to count attempts rather than
completions.

**What I would like from you, and it is small.** If the journal-entry shape you emit is open,
tell me which field you would map `consumed` and `redeem_count` onto — or just tell me the
shape and I will propose a mapping. I will write it into the spec and credit Counterra as the
first accounting-side consumer.

If you think neither field belongs in an accounting record, say so — that is a more useful
answer than silence and I would rather hear it.

Disclosure: I wrote the spec. I am not selling anything here; the fields are free, and the
three red lines are no funds, no scoring, and never storing the credential body.
