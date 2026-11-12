> **Name note.** The header below still says "Posted: pending". The reply was sent as [this comment](https://github.com/StelarDigital/x402-receipts/issues/6#issuecomment-6081826670) while the project was called `gates-spec`. The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged. The commit link is the URL recorded with this note. The same commit is in this repository: https://github.com/ruiruii/sycee/commit/2489ce1ee6b059f8c7dd7dc6a2923c78a404676c

# Round 4 — reply to x402-receipts #6

Posted: pending
In reply to: comment #6081466437 (2026-10-09T13:05:09Z, baianomarceloeduardo-jpg)
Commit referenced: `2489ce1` — https://github.com/ruiruii/gates-spec/commit/2489ce1ee6b059f8c7dd7dc6a2923c78a404676c

## What he gave us

- Base origin: `https://api.automaton-sovereign.workers.dev`
- `/v2/pubkey`, `/v2/ledger?limit=50`, `/v2/verify?index=N`, `/v1/verify-payment?txHash=…`
- Index 20 attests the payment (`2026-09-30T12:21:40.058Z`, hash `c71f0e2f…`, current key `6db8674197d1601f`)
- Index 0 is the retired-key negative case (`2026-09-25T14:34:35.659Z`, hash `78941ded…`, retired key `7e32754cf3911ccf`)
- Cite **v0.5.0** (npm `latest`), not v0.5.1

## What we could and could not do

- On-chain half: independently verified earlier against a public Base RPC. Stands.
- Ledger half: **could not be reproduced from this build environment.** DNS here resolves
  unknown hosts to placeholder addresses; every connection to the origin times out while
  control hosts resolve fine. This is an environment restriction, not a finding.
- Therefore the record marks RW-001 as "payment verified, ledger pending" and says so
  explicitly. We did not take 33/33 on his word and we did not claim to have checked it.

Harness shipped instead: `conformance/real-world/verify-rw001.mjs`, zero dependencies.

## Two assertions added that he did not supply

1. **Link check** — `entries[i].prevHash === entries[i-1].hash` and index contiguity.
   A ledger can satisfy `sha256(prevHash|timestamp|dataHash)` entry-by-entry and still be
   unlinked. 33/33 does not prove it is a chain.
2. **Negative direction of the retired key** — index 0 must verify against
   `7e32754cf3911ccf` and must **fail** against `6db8674197d1601f`. A verifier that passes
   both directions is not checking key binding.

## The observation worth more than the vector

He verified the payment on-chain at `2026-09-30T11:38:11.311Z`.
The epoch attesting it is index 20 at `12:21:40.058Z` — **~43 minutes later**.

For up to one epoch interval, a payment is settled on-chain and invisible to anyone reading
the attestation ledger. That is the general shape of the problem, not a defect in his design:
**not yet observable ≠ not settled**. It is what `settlement_status` (`settled | in_flight |
absent`) exists to carry, and why settlement is not a boolean.

## Three questions asked

1. Is the epoch periodic, and at what interval? (real-world prior for `freshness_s`)
2. Does a `tx_already_used` refusal get written into the ledger, or only returned as the 402?
   (the exact gap `redeem_count` closes)
3. Willing to let RW-001 be a cross-implementation vector re-verified by our CI rather than
   by either side quoting the other?

## Standing commitments restated

- Cite his wire mapping, not his OpenAPI, until the two defects ship.
- Version reference: v0.5.0.
- Provenance carried verbatim: his own paid self-test, not a customer payment.
