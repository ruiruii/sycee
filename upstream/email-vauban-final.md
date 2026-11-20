# Vauban liaison email — final draft (2026-11-20)

To: research@vauban.tech
Subject: `consumed` / `redeem_count` for draft-vauban-x402-stark-receipts, before the 11-26 expiry

Send from a real address on a project domain if one exists; a personal alias gets filtered.
Attach nothing. Link only.

---

Hello Vauban Research,

I've read `draft-vauban-x402-stark-receipts`. The negotiable receipt-format selection — letting resource servers, facilitators and clients agree on which cryptographic variant to produce without changing the core PAYMENT-RESPONSE wire structure — is the right call, and the STARK / ML-DSA-65 variants put you ahead on post-quantum receipt integrity.

I'm writing about two questions the draft, and every other receipt spec I can find, does not answer.

**1. Was the result actually consumed?** Your receipt binds a payment to a delivered response. `delivery.status: "delivered"` is the seller's statement about bytes it sent. An agent can pay, receive a perfectly valid response, and never place it in context — prompt budget exhausted, a downstream step discarded it, a retry superseded it. That is idle spend: real cost, no downstream effect, today indistinguishable from a used result.

**2. How many times was one payment proof redeemed?** x402's in-flight dedup stops concurrent replay, but the protocol permits multiple `complete` transitions per proof, and sequential reuse across requests or resources is neither prevented nor recorded. See [brave/bx402#102](https://github.com/brave/bx402/issues/102) for a live case.

### What exists, and what it deliberately is not

`SYCEE v0.1` — https://github.com/ruiruii/sycee — defines two fields and nothing else: `result.consumed` (`yes` / `no` / `unknown`, with `consumed_by` / `consumed_at`) and `payment.redeem_count` (with `redeem_resources`). JSON Schema, an Ed25519 reference implementation, 203 tests, 12 signed conformance vectors, and two independent implementations — JavaScript and Python, written from the spec text, agreeing on every vector and every level — Apache-2.0, no dependencies.

It is not a competing receipt format. It adds two fields to whichever format wins — including yours.

One point that may matter for a spec that signs on the seller's side: `consumed` cannot be signed by the seller. A merchant that signs `consumed: yes` is asserting something it has no observation of, and our conformance suite refuses such a receipt at construction. So the field implies a buyer-side or joint signature, which is a structural question for your envelope rather than a naming one.

### What I'm asking

Before the 2026-11-26 expiry:

1. Would you consider `consumed` / `redeem_count` as optional extension fields in the next revision, under an `outcome` block or wherever you prefer to place them?
2. If a 15-minute call would help fix the names, I'm available — the failure I want to avoid is the ecosystem forking into `used` / `utilized` / `redeemed` / `redemption_count`.

I'm equally happy to adopt your names and retire mine. The objective is one vocabulary, not a new project. If these fields belong inside an envelope field you already define, say which and I'll conform.

Same proposal is open on `StelarDigital/x402-receipts` ([#6](https://github.com/StelarDigital/x402-receipts/issues/6)) and on the ERC-8004 contracts repo, so the three tracks stay aligned.

Thank you for the draft — it made this proposal much easier to write precisely.

Best regards,

Rachel
SYCEE
https://github.com/ruiruii/sycee

---

## Notes before sending

- **Timing.** 9 days to expiry. Sending today leaves one working week for a `-03` revision; after 11-27 it is a post-mortem, not a proposal.
- **Cut if needed.** If you want a higher reply rate, drop the "What exists" section to two sentences and keep only the two questions and the structural point about who can sign `consumed`.
- **No attachment.** Link the repo. `.eml` from an unknown sender goes to spam.
- **The Python checker is public** (`python/sycee_verify`, commit `66cf215`), so the two-implementation sentence is now checkable rather than asserted.
