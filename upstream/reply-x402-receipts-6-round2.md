> **Name note.** This was sent when the project was called `gates-spec`. The project is now **SYCEE**: https://github.com/ruiruii/sycee. The text below is unchanged. The commit link is the URL recorded at send time. The same commit is in this repository: https://github.com/ruiruii/sycee/commit/d015c76e99aebaf68a5b96ab9e6b1fe0533578fb

# Reply — x402-receipts #6, round 2 (settlement codomain shipped)

Status: **POSTED 2026-10-09 12:21 UTC**
https://github.com/StelarDigital/x402-receipts/issues/6#issuecomment-6080765543
Commit referenced: `d015c76` — https://github.com/ruiruii/gates-spec/commit/d015c76e99aebaf68a5b96ab9e6b1fe0533578fb
Next dependency: their real Base mainnet vector (block 51984731) — waiting on them.

---

@baianomarceloeduardo-jpg — shipped. See {SHA_LINK} (and `28525be` before it for the
`consumed` role constraint).

**What landed**

1. `payment.settlement_status` with exactly your enum: `settled | in_flight | absent`.
   Default `in_flight` — "not yet observable ≠ not settled", never `absent`.
2. Not a fourth predicate, not a gating field. It is the settlement predicate's own
   codomain, and it is reported as `settlement.consistency` beside the verdict rather
   than gating anything. Your "gates" observation was right and I stopped gating.
3. Both of your normative consequences, written into SPEC §6.1.1:
   - `delivered` + `in_flight` = **incomplete**, not inconsistent.
   - `delivered` + `absent` = **contradiction**, a verifier MUST flag. Hard error by
     default, with an explicit `allowUnpaidDelivery` opt-out — a seller that knowingly
     serves unpaid has to say so out loud.
   - `settled` + `failed | timeout` = warning only. Paid without fulfilment is dispute
     material, not a malformed receipt.
4. Fail-closed is preserved. `in_flight` still does not make a receipt valid;
   `verifyVSR(env, { requireSettled: true })` returns `valid: false` with a reason
   containing `in_flight`, so a verifier can report "unproven yet" instead of "refuted".
5. Wire compatibility exactly as you asked. The body enum is ours; `normalizeSettlement()`
   maps a transport's own value onto it (`true → settled`, `queued → in_flight`,
   `false` / `absent` → `absent`). We do **not** adopt `X-Payment-Settled` as a header
   name, and nothing changes on your wire.
6. The middleware populates it in this order: `verifyPayment`'s own report → a
   `settlementFor` hook → the `x-payment-settled` wire header → default `in_flight`.

Conformance vectors went 9 → 12: added `valid-settlement-in-flight`,
`valid-settlement-settled-undelivered`, and `invalid-settlement-absent-delivered`.
20 tests green; vectors stay byte-reproducible so CI catches drift.

**One thing your correction changed beyond the field.** That a seller writing `consumed`
is unfalsifiable made me delete a shipped feature — the inline `x-gates-consumed` hint —
rather than document around it. That is `28525be`.

**Still open, and it is yours to give:** the §9 real-world vector. Send me
(1) the public verify endpoint shape, (2) the exact attestation envelope you emit on the
settle path, (3) the `X-Payment-Settled` mapping you actually run — and I will add it as a
real-world conformance vector credited to your origin, distinct from the synthetic Ed25519
ones. Block 51984731, 20.000 units to your `payTo`, provenance stated as you gave it:
your own paid self-test, not a customer payment.
