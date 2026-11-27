## What this is

A field map between a Lumière PayCheck signed receipt and a SYCEE reconciliation
attestation. It is how we reference a receipt Elijah signed inside a buyer-side
claim, without asking either side to change its format.

This is a reference we wrote for ourselves, offered here for correction. It is not
a proposal that PayCheck change anything.

## Context

The thread was `Book0fEli/lumiere-paycheck#60`. Two things came out of it that
matter here:

- PayCheck now carries `responseBasis` (`body` / `async_result` / `empty`, `responseHash`
  null when there is no body) and a digest per member of the request. Both were our
  suggestions; Elijah shipped them.
- We drafted the buyer-side counterpart:
  [`docs/notes/reconciliation-attestation.md`](../blob/main/docs/notes/reconciliation-attestation.md).
  An attestation is signed by the buyer, expires, and says which members of one
  attempt diverged. It deliberately carries no "who is right" claim.

## The map

| PayCheck receipt field | Attestation field | How |
|---|---|---|
| `id` | — | local index only; not a cross-system join key |
| `url` | `subject.resource_id` | receipt uses an absolute URL, our `resource_id` is a stable seller-assigned identifier — an agreed alias is needed |
| `network`, `asset`, `amountQuoted`, `payTo` | inputs to `subject.attempt_identity` | composed by the buyer at ingress (SPEC §3.1), never adopted from a seller or a receipt |
| `termsHash` | top-level check, not an attestation member | see caveat 1 |
| `responseHash`, `responseBytes`, `responseBasis` | — | an attestation describes two ledgers, not delivered content |
| `httpStatus`, `outcome` | `observation.outcome` | 2xx → `served`; 402 → `refused`; no response → `no_response` |
| `commitment`, `revealed` | — | settlement facts; §10 forbids asserting them from the buyer side |
| per-member digests | `observation.members` | same idea, different field names and order — see caveat 3 |

## Three interface gaps

These are recorded as caveats, not findings. None of them asks PayCheck to change.

**1. `termsHash` is not recomputable from the receipt itself.** The documented
formula is `sha256(JSON.stringify(["x402-terms.v1", url, scheme, network, asset,
amount, payTo]))`. Against a live receipt from 2026-11-18
(`marketintelligenceapi.com`, `responseBytes: 348`), verified with the JWKS key
`paycheck-receipts-1`:

- recomputing without `scheme` does not match;
- inserting `scheme: "exact"` matches exactly.

So `scheme` is an input to the hash and absent from the payload. An outside
verifier has to supply a value the artifact does not carry. Smallest fix, if it
ever matters: carry a `terms: {…}` object including `scheme`, plus a `termsVersion`
for the recipe. This is the same move already made for `responseHash` with
`responseBasis`.

**2. No attempt identity in the receipt.** Two receipts of the same URL at
different prices are indistinguishable in a join. One line would fix that:
`sha256("sycee/attempt/v1"|method|origin|path|query|payTo|asset|network|amount|scheme)`.

**3. `query` is a flag only.** That loses the distinction between "a query differed"
and "which query differed". The narrow risk is that a short query is recoverable
from its digest — so digest it when long, flag it when short. PayCheck's `body`
digest already has this shape.

## Verifiable check

No dependencies. Against any live receipt:

```js
import { createPublicKey, verify, createHash } from 'node:crypto';
const sha = s => createHash('sha256').update(s).digest('hex');
const jwks = await (await fetch('https://lumierepaycheck.org/.well-known/jwks.json')).json();
const key = createPublicKey({ key: jwks.keys.find(k => k.kid === 'paycheck-receipts-1'), format: 'jwk' });
const [body, sig] = receipt.split('.');
console.log(verify(null, Buffer.from('paycheck-test-receipt.v1.' + body, 'ascii'), key, Buffer.from(sig, 'base64url')));
const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
console.log(sha(JSON.stringify(["x402-terms.v1", p.url, "exact", p.network, p.asset, p.amountQuoted, p.payTo])) === p.termsHash);
```

The first line should be `true` for any receipt. The second is `true` only when
the scheme is supplied from outside.

## Boundary

An attestation may not assert settlement, delivery, fault, or an amount received.
Those four are a closed enum in its schema (`scope.does_not_assert`), so the
boundary travels with the artifact. A PayCheck receipt referenced by hash stays
one input among several — it never becomes a verdict.

@Book0fEli — if you are willing, I would value a correction on any line of the
mapping above. No need to act on the caveats; I just did not want to write this
from one side and call it agreed.

— Rachel
