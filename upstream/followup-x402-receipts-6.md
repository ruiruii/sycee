# Follow-up for StelarDigital/x402-receipts#6

Post as a comment on: https://github.com/StelarDigital/x402-receipts/issues/6
Last comment there is 2026-10-11. Do not post before the Python checker passes (see note at the bottom).

---

@baianomarceloeduardo-jpg — closing the loop on what your answer changed, and one question only you can answer.

Since 10-11 the invariant landed as we agreed, in §3.1 of the spec:

- **Positive:** derived once, at ingress, from the request as received; settle and refusal resolve the same `attempt_id`.
- **Negative, and the one the tests assert:** no path re-reads `accepts` after ingress.
- **Composition:** decoded, named fields — never wire array order.

Your credit line is quoted as given. The practical effect: the refusal-side ledger and the settlement-side receipt now resolve one identity instead of two, which is the divergence you said the placement rule would retire.

Two things are new since, both aimed at making the third predicate runnable instead of argued:

1. **A demo where the difference is the only thing on screen.** The same search is bought twice. Both calls return 200, both are charged, both produce a signed receipt — and the seller records `consumed: unknown` for both, because the seller has no observation of downstream. The buyer's runtime signs `yes` for the result it passed into a prompt and `no` for the one it dropped. Same delivery, different outcome, and the delivery receipt cannot express the difference: `examples/bilateral-consumption.mjs`.
2. **12 signed conformance vectors** (7 valid, 5 invalid) covering `consumed: yes | no | unknown`, `redeem_count: 1 | 3`, and the rejection cases — including a merchant that signs `consumed: yes`, which is refused at construction because it asserts something a seller cannot observe.

No adopter outside this repository yet, so I'm not claiming traction — only that the shape is now executable, not just specified.

**The question.** If `x402-receipts` ever opens a v0.6, where would you want the two fields to sit: inside the existing `delivery` extension block, or as a sibling `result` block? I'll conform to your answer either way. I'm asking because I'd rather cite a placement decision from you than invent one and end up with two shapes in the wild — which is the exact failure `redeem_count` exists to prevent, one layer up.

If the repo is in maintenance and this is not a v0.6 question, say so and I'll cite your §5 split as the anchor and stop asking. Either answer closes the thread; a non-answer doesn't need one.

— Rachel

---

## Notes before posting

- Wait for the Python verifier to pass all 12 vectors before posting, then add one line:
  "An independent Python implementation now checks the same 12 vectors and reaches the same verdicts, so the format is not single-implementation."
- Do not ask for a call. Their repo has not moved since 2026-07-31; a meeting request on a dormant repo reads as pressure.
- Do not re-raise `redeem_count` mechanics. It was settled in this thread; repeating it reads as not having read the answer.
