# Why a diagnostic header must not become a second identity key

A design note about `x-sycee-members`, and about a failure that shows up in any
system where one party publishes values for another to check against.

## The tempting move

An attempt identity is a hash over nine members — method, origin, path, query,
payTo, asset, network, amount, scheme. When two parties disagree about a payment,
the useful question is *which member diverged*. So we publish them:

> `x-sycee-members`: a base64url JSON object, one `sha256:<hex>` per member over the
> value as composed. `query` is published as `null`, never a digest.

The header goes out on success and on refusal, because a refusal is what an
operator investigates first and what a proxy is most likely to have rewritten.

Now the tempting move: the buyer received the nine members. Why recompute them?
It can just adopt the published ones and compare.

## Why that move destroys the check

Adopting the published members makes every comparison pass by construction. The
buyer is comparing a value with itself. A header whose entire purpose is to
locate a divergence becomes a machine for certifying that no divergence exists —
including when there is one.

That is not a cosmetic problem. It is the exact failure the header was built to
help locate: a proxy rewrote `origin`, a framework normalized `path`, a rounding
step changed `amount`. If the buyer adopts the seller's published members, all
three become invisible. The buyer gets a clean `match` on a request it never
sent.

The rule in the spec is deliberately absolute:

> A buyer MUST compose its identity from the request and the challenge, and MUST
> NOT adopt a published value. — SPEC.md, "Locating a divergence"

The timing is what makes this safe. The buyer's key is computed *before the
response arrives*, from two things the seller did not choose: the request the
buyer sent and the 402 challenge the buyer received. Publishing the members
afterward cannot retroactively change it. The diagnostic is a copy of the
answer, handed over only once the answer is already locked in.

## The part that is easy to get wrong

`query` is published as `null`, not as a digest. This looks like an omission; it
is a security decision. A query string usually carries an API key — a short,
low-entropy secret. A digest of it is trivially reversible by trying the values
a caller plausibly sends, and the buyer already knows exactly what it sent. So a
digest would leak the very thing the field exists to hold. `null` says: this
member is intentionally not a diagnostic, because it cannot be one safely.

The second easy mistake is to treat the header as a second key — an alternative
identity a verifier will accept if the hash "looks right". It is not. It is the
same nine members, pre-digested, for a reader who wants to know *where* two rows
differed rather than *that* they differed. One identity, one computation, two
representations. If the two ever disagree, the computed one wins, always.

## Why this matters beyond x402

The shape is general: one party publishes values, another party is asked to
check against them. It shows up in signed delivery receipts, in observatory
evidence, in any "seller attests, third party verifies" design. Wherever a
verifier is handed the values it is meant to verify, the check degenerates into
agreement. The interesting question is never "do these two hashes match" — it is
"could the party being checked have chosen the value I am checking against?"

For attempt identity the answer is no. The buyer chose the request; the seller
chose the challenge. Neither chose both. That single property is what makes a
divergence meaningful, and it is the thing a diagnostic header must never be
allowed to replace.

## Related

- SPEC.md § "Locating a divergence" — the normative rule and the `query: null` requirement.
- `x402-foundation/x402#4116` — the signed-delivery-receipt discussion this note is written against.
- `specs/extensions/refusal-row.md` §12 — observatory evidence and why a second reader matters.
