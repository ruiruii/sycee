# SYCEE quickstart — Express

One paid route, five minutes. SYCEE adds **how many times the same payment proof was redeemed** and a signed receipt to an endpoint you already charge for. It does not verify payments and does not move money.

## Quick start

```bash
git clone https://github.com/ruiruii/sycee.git && cd sycee/examples/quickstart-express
npm install
npm start                     # http://localhost:3000
curl -i -H 'payment-signature: demo-proof-1' 'http://localhost:3000/search?q=hello'
```

## What you should see

Verified against a local run (`PORT=3111`, `DEMO_FACILITATOR` unset, headers abridged with `…`).

**1. No `payment-signature` → 402, no receipt**

```
HTTP/1.1 402 Payment Required
content-type: application/json

{"error":"payment_required","gates_spec":"v0.1","resource":"search.v1","accepts":[{"protocol":"x402","price":{"value":"0.010000","currency":"USDC"},"note":"Include a payment proof. SYCEE only records its hash."}]}
```

**2. First use of a proof → 200 with receipt**

```
HTTP/1.1 200 OK
x-gates-proof-hash: sha256:5b805f003aa8fc6cb70ff60e8ffbccbdb3e932ad8892c220395058b4462cb886
x-gates-redeem-count: 1
x-gates-receipt: eyJzaWduYXR1cmUiOiI1NXBrYnBrVmwyQkNiVGd6SGRSN3BGVUszaEc3WHFG…   (base64url VSR, also in the body under `_gates`)
x-gates-receipt-url: http://localhost:3111/receipt/5b805f003aa8fc6c
x-gates-settlement-status: settled

{"query":"hello","results":[{"title":"Result for \"hello\"","url":"https://example.com/?q=hello"}],"_gates":{…}}
```

**3. The same proof again → `redeem_count` goes up**

```
HTTP/1.1 200 OK
x-gates-redeem-count: 2
```

Counted, not blocked — that is `replayPolicy: 'count'` (the default). The server log shows it too:

```
[search] q="hello" proof=sha256:5b805f003aa8… redeem_count=1
[search] q="hello" proof=sha256:5b805f003aa8… redeem_count=2
```

**4. A proof your verifier rejects → 402, refusal recorded**

```
HTTP/1.1 402 Payment Required
x-gates-refusal-reason: invalid_signature
x-gates-refusal: eyJhdHRlbXB0X2lkZW50aXR5Ijoic2hhMjU2OjVjNGRiYTgx…   (signed refusal row)
x-gates-proof-hash: sha256:ca3704aa0b06f5954c79ee837faa152d84d6b2d42838f0637a15eda8337dbdce

{"error":"payment_rejected","reason":"invalid_signature","refusal_reason":"invalid_signature","refusal_receipt":{…}}
```

A refusal is recorded with the same weight as an acceptance, so the buyer can point at something. The response deliberately carries no `x-gates-receipt`.

## Plugging in your facilitator

`verifyPayment` is the only place a payment is judged:

```js
verifyPayment: async (proof, req) => ({ ok, tradeNo, reason, settlement })
```

| field | meaning |
| --- | --- |
| `proof` | raw `payment-signature` header value, passed through untouched |
| `req` | the Express request (method, `originalUrl`, headers, …) |
| `ok` | `true` accepts; `false` returns 402 and records a refusal |
| `tradeNo` | your facilitator's payment id, if any (not stored by SYCEE) |
| `reason` | on refusal, a wire string such as `invalid_signature` |
| `settlement` | `'settled'` / `'in_flight'` / `'absent'`, or `true` for settled. Optional; defaults to `in_flight` |

The example ships a fake verifier so it runs with nothing else installed: `demo-` prefixed proofs pass. To use the real thing, set `DEMO_FACILITATOR=0` and `FACILITATOR_URL`, then fill in the fetch call in `server.mjs`:

```js
const res = await fetch(`${FACILITATOR_URL}/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ proof, resource: 'search.v1', price: { value: '0.010000', currency: 'USDC' } }),
});
if (!res.ok) return { ok: false, reason: 'internal_error' };
const v = await res.json();               // { ok, tradeNo?, settlement? }
return v.ok ? { ok: true, tradeNo: v.tradeNo, settlement: v.settlement ?? 'in_flight' }
            : { ok: false, reason: v.reason ?? 'invalid_signature' };
```

## Production notes

**Swap the store.** The default `memoryStore()` lives in one process: a restart forgets every redeem count, and two instances behind a load balancer each count from 1. Use Redis instead.

```js
import { createClient } from 'redis';
import { createGates, redisStore } from '@sycee/middleware';

const client = await createClient({ url: process.env.REDIS_URL }).connect();
const gates = createGates({
  /* … */
  store: redisStore(client, { prefix: 'gates:proof:', ttlDays: 90 }),
});
```

`ttlDays` is how long a proof hash is remembered; keep it at least as long as a payment authorization can be replayed.

**Pick a replay policy.** `replayPolicy: 'count'` (default) serves the repeat and records `redeem_count: 2`. `replayPolicy: 'refuse'` records the repeat and returns 402 with a refusal receipt, so a buyer is never silently billed twice. Neither one decides for you — choose per route.

**Persist your signing key.** `server.mjs` calls `generateKeyPair()` at boot for demo purposes. Every restart therefore produces a new key, and receipts issued before the restart will no longer verify. Generate one keypair, store the private key in your secret manager, and load it at startup.

**Behind a reverse proxy.** The receipt URL and request fingerprint are built from `req.headers.host` and `x-forwarded-proto`, so forward both headers from your proxy and enable `app.set('trust proxy', 1)`. Otherwise receipts will advertise an internal host.

## The red line

SYCEE does not verify payments and never touches funds. Whether a payment is real, and when it settles, remains your facilitator's job — `verifyPayment` is only a bridge to it.
