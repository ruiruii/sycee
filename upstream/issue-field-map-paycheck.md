## What this is

A field map between a Lumière PayCheck signed receipt and a SYCEE reconciliation
attestation, kept here as **our own working note**.

**Not an integration.** PayCheck's receipt format is Lumière's own; it is not
aligned with or built to the SYCEE spec. Nothing on this page should be read as
an integration, an agreed compatibility claim, or a mapping Elijah has reviewed.
We offered it for correction; he declined to review it line by line. It records
how *we* would reference a receipt he signed, and nothing more.

## Context

The thread was `Book0fEli/lumiere-paycheck#60`. Two of our suggestions —
`responseBasis` and a digest per request member — were adopted by PayCheck. That
is recorded as history, not as a compatibility claim. We drafted the buyer-side
counterpart:
[`docs/notes/reconciliation-attestation.md`](../blob/main/docs/notes/reconciliation-attestation.md).
An attestation is signed by the buyer, expires, and says which members of one
attempt diverged. It deliberately carries no "who is right" claim.

## The map

| PayCheck receipt field | Attestation field | How |
|---|---|---|
| `id` | — | local index only; not a cross-system join key |
| `url` | `subject.resource_id` | receipt uses an absolute URL, our `resource_id` is a stable seller-assigned identifier — an agreed alias would be needed |
| `network`, `asset`, `amountQuoted`, `payTo` | inputs to `subject.attempt_identity` | composed by the buyer at ingress (SPEC §3.1), never adopted from a seller or a receipt |
| `termsHash` | top-level check, not an attestation member | see caveat 1 — now resolved by Lumière |
| `responseHash`, `responseBytes`, `responseBasis` | — | an attestation describes two ledgers, not delivered content |
| `httpStatus`, `outcome` | `observation.outcome` | 2xx → `served`; 402 → `refused`; no response → `no_response` |
| `commitment`, `revealed` | — | settlement facts; §10 forbids asserting them from the buyer side |
| per-member digests | `observation.members` | same idea, different field names and order — see caveat 3 |

## Caveat 1 — resolved by Lumière

`termsHash` is now recomputable from the receipt itself. Lumière confirmed
(2026-11-27): receipts signed from now on carry `scheme` and `termsVersion`, so
`sha256(JSON.stringify(["x402-terms.v1", url, scheme, network, asset, amount, payTo]))`
is computable from the artifact alone, and `POST /v1/test-receipts/verify`
returns `termsHashRecomputes`. Older receipts are checked with `exact`.

The check below is kept as a record of how we found the original gap; it is not
a claim about current receipts.

## Caveats 2 and 3 — withdrawn

We raised two more points and Lumière declined both. We accept that decision;
they were our design preferences, not defects in a receipt.

- **Attempt identity.** Two receipts at different prices are already different:
  `termsHash` covers the amount and `amountQuoted` is in plain text. Our
  `attempt_identity` is a SYCEE design choice for joining two ledgers, not
  something a PayCheck receipt owes us.
- **`query` as a flag.** Query strings often carry API keys. A flag is the right
  call; our long/short split was not a strong enough reason to publish any digest
  of a query.

## Verifiable check

No dependencies. For current receipts, use the fields the receipt now carries;
`exact` is only for legacy receipts.

```js
import { createPublicKey, verify, createHash } from 'node:crypto';
const sha = s => createHash('sha256').update(s).digest('hex');
const jwks = await (await fetch('https://lumierepaycheck.org/.well-known/jwks.json')).json();
const key = createPublicKey({ key: jwks.keys.find(k => k.kid === 'paycheck-receipts-1'), format: 'jwk' });
const [body, sig] = receipt.split('.');
console.log(verify(null, Buffer.from('paycheck-test-receipt.v1.' + body, 'ascii'), key, Buffer.from(sig, 'base64url')));
const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
const scheme = p.scheme ?? 'exact'; // legacy only
console.log(sha(JSON.stringify(["x402-terms.v1", p.url, scheme, p.network, p.asset, p.amountQuoted, p.payTo])) === p.termsHash);
```

## Boundary

An attestation may not assert settlement, delivery, fault, or an amount received.
Those four are a closed enum in its schema (`scope.does_not_assert`), so the
boundary travels with the artifact. A PayCheck receipt referenced by hash stays
one input among several — it never becomes a verdict.

No action requested from Lumière.
