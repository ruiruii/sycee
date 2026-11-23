Title: 37 on-chain payments vs 39 receipts — a verifier that might help, and one question about EIP-2612

Hi — I read your 13 August devlog (updated 17 November) with interest, especially the part where your reconcile endpoint reports 37 on-chain payments against 39 logged receipts, and your own note that one-to-one matching needs the settlement hash on the paid path. That gap is the thing we built SYCEE around, and I'd like to ask a small favour — plus raise one question from reading your facilitator.

The favour first. We just published a verifier you can run without cloning anything:

    npx sycee-verify --example

It prints three built-in receipts and which rule each passes or fails. If you're willing, two things would help us more than anything we could write ourselves:

1. Permission to cite that devlog entry as the source for "a real seller had this problem, in their own words" — your words, not ours.
2. One refusal row run through your reconcile endpoint, to see whether the two ledgers join on the attempt identity.

If either is a no, that's completely fine. The question below stands on its own and I'll leave it there.

The question, from reading `src/core/facilitator.ts` on main (2026-11-20). Credit first: the `verify()` binding hole from #3 is closed — the code now reads `requirements` and calls `verifyPaymentForRequirements`. I am not reopening that.

What I noticed is on the reporting side. EIP-2612 is correctly treated as two transactions — `permit()` then `transferFrom()` (`:155-158`, waited on at `:172-179`, submitted at `:184-192`). But the failure path at `:231-232` returns one `success: false` and one `errorReason: 'Transaction reverted on-chain'`, and `permitHash` is logged at `:179` and never returned. So a caller cannot tell apart:

- permit reverted, nonce still unspent — retrying with that signature is right;
- permit executed, `transferFrom` reverted, nonce spent — retrying with that signature can no longer succeed.

The in-process guard is released in the `finally` block (`:238-239`) in both cases.

I'm not asking you to adopt our vocabulary. The only question is whether "which leg failed" and "was the nonce spent" are representable in that response. If they already are and I missed them, point me at the line and I'll correct this publicly.

— Rachel
