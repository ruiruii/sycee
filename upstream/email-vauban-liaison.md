To: research@vauban.tech
Cc: (x402 WG / IETF list)
Subject: SYCEE v0.1 — proposing `consumed` / `redeem_count` as optional extensions to draft-vauban-x402-stark-receipts

---

## Email body

Hello Vauban Research,

I've read `draft-vauban-x402-stark-receipts` with interest. The negotiable
receipt-format selection mechanism — letting resource servers, facilitators, and
clients agree on which cryptographic receipt variant to produce, without altering the
core PAYMENT-RESPONSE wire structure — is the right architectural call. The STARK and
ML-DSA-65 variants put you well ahead on post-quantum receipt integrity, and the EU AI
Act Art. 12 / MiCA Art. 76 framing is the compliance hook this space has been missing.

I'm writing because of two questions your draft (and, as far as I can tell, every other
receipt spec) does not currently answer.

**1. Was the result actually consumed?**
Your receipt binds a payment to a delivered response. `delivery.status: "delivered"` is
the seller's statement about bytes it sent. But an agent can pay, receive a perfectly
valid response, and never place it in context — prompt budget exhausted, a downstream
step discarded it, a retry superseded it. That is idle spend: real cost, zero downstream
effect. Today it is indistinguishable from a genuinely used result.

**2. How many times was the same payment proof redeemed?**
x402's in-flight dedup prevents *concurrent* replay of a `payment_proof`, but the
protocol permits multiple `complete` transitions for one proof. Sequential reuse across
separate requests or resources is neither prevented nor recorded. See
[brave/bx402#102](https://github.com/brave/bx402/issues/102) ("one payment buys N
upstream calls") for a live instance.

### What I published

**SYCEE v0.1** — https://github.com/ruiruii/sycee

- `SPEC.md` defining two semantic fields and nothing else:
  - `agent.spend.result.consumed` — `yes` | `no` | `unknown`, plus `consumed_by`,
    `consumed_at`, `freshness_s`
  - `agent.spend.payment.redeem_count` — how many `complete` events one proof produced,
    plus `redeem_resources`
- JSON Schema, Ed25519 reference implementation (merchant middleware + agent SDK)
- 9 conformance vectors; CI green on Node 18/20/22; Apache-2.0; zero dependencies
- Protocol-agnostic: the same attributes map onto x402, MPP, AP2, APOP, A2P2, card-A2A

It is deliberately **not** a competing receipt format. It adds two fields to whatever
receipt format wins.

### What I'm asking

Before your draft's 2026-11-29 expiry, would you consider:

1. **Adopting `consumed` / `redeem_count` as optional extension fields** in
   `draft-vauban-x402-stark-receipts`, under an `outcome` block or however you prefer to
   structure it.
2. **A 30-minute call** to agree on field names, so the ecosystem doesn't fork into
   `used` / `utilized` / `redeemed` / `redemption_count`.
3. **Cross-verification mapping** between your STARK/ML-DSA-65 receipts and Ed25519
   VSRs, so implementations can check one against the other.

I'm equally happy to adopt your names and retire mine — the objective is one vocabulary,
not a new project. If you'd rather these fields live inside an existing envelope field
you already define, say so and I'll conform.

I've also raised the same proposal as an issue on `StelarDigital/x402-receipts`
([#6](https://github.com/StelarDigital/x402-receipts/issues/6)) and on the ERC-8004
contracts repo, so all three tracks stay aligned.

Thank you for the draft — it made this proposal much easier to write precisely.

Best regards,

[Your name]
SYCEE
https://github.com/ruiruii/sycee

---

## Notes before sending

- **Send from a real address.** A proposal from `research@` to a company domain carries
  more weight than one from a personal alias; if Sycee has a domain, use it.
- **Keep it short.** If you want a higher reply rate, cut the "What I published" section
  to two sentences and keep only the two questions.
- **Timing.** Their draft expires 2026-11-29. Sending within the next week gives them
  time to fold this into a `-03` revision.
- **Attach nothing.** Link the repo instead; attachments from unknown senders get filtered.
