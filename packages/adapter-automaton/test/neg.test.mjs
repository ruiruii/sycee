/**
 * NEG-3 / NEG-4 — the two negative conformance tests x402#3776 lists under
 * "Required negative conformance tests (normative follow-up)" and does not yet
 * ship. Both test the *detector*, not the text.
 *
 * Why they exist: a vector that cannot fail on a violating implementation
 * covers nothing, and a suite that compares values cannot see a derivation
 * that happens at the wrong moment. Each statement below is executable.
 *
 *   NEG-3 … all four paths report the same value, and one of them derived it
 *   at settle time from request content that was not in the ingress snapshot.
 *   A runner that compares values reports conformance, because the value
 *   happened to come out the same. A runner that only compares outputs passes
 *   and must be failed.
 *
 *   NEG-4 … disable the trigger, keep the check body — the suite must fail. If
 *   it still passes, the check was never reachable and the vector covered
 *   nothing.
 *
 * The fixture property NEG-3 asks for — "two derivations produce the same value
 * from different inputs" — needs no hash collision. It is the ordinary case
 * where one object is a re-serialization of another: `deepCanonicalize()` sorts
 * keys, so key order is invisible in the digest while object identity, read
 * order and derivation moment stay distinguishable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveIngressSnapshot, referenceComposition } from '../src/index.mjs';

/** The request as it arrived. Frozen: ingress must not need to mutate it. */
const INGRESS_REQUEST = Object.freeze({
  method: 'POST',
  url: 'https://api.example/buy',
  params: {},
  payTo: '0xabc',
  amount: '1',
  asset: 'USDC',
  scheme: 'exact',
});

/**
 * The same offer, one level downstream: a different object, different key
 * order, same canonical content. This is what a request looks like after a
 * JSON round-trip through middleware — the case where a re-derivation at
 * settle time goes unnoticed.
 */
function settleTimeRequest() {
  return {
    scheme: 'exact',
    asset: 'USDC',
    amount: '1',
    payTo: '0xabc',
    params: {},
    url: 'https://api.example/buy',
    method: 'POST',
  };
}

/**
 * Records which properties of a request an implementation actually read.
 * Reading zero properties is the observable form of "derived once at ingress".
 */
function watched(request) {
  const reads = [];
  const proxy = new Proxy(request, {
    get(target, key) {
      if (typeof key === 'string') reads.push(key);
      return target[key];
    },
    has(target, key) {
      if (typeof key === 'string') reads.push(`has:${key}`);
      return key in target;
    },
  });
  return { proxy, reads };
}

/** A runner of exactly the shape NEG-3 names: it compares outputs, nothing else. */
function valueComparingRunner(impl) {
  const out = [impl.settle(), impl.refusal(), impl.replayLookup(), impl.challengeQuote()];
  return new Set(out).size === 1;
}

/* ------------------------------------------------------------------ *
 * NEG-3a — the false positive a value-comparing runner cannot avoid
 * ------------------------------------------------------------------ */

test('NEG-3 · a re-derivation at settle time yields the same value and is invisible to a value-comparing runner', () => {
  const snapshot = deriveIngressSnapshot(INGRESS_REQUEST);

  // Compliant: settle takes the request and never looks at it.
  const compliant = {
    settle: (_req) => snapshot.attemptId,
    refusal: () => snapshot.attemptId,
    replayLookup: () => snapshot.attemptId,
    challengeQuote: () => snapshot.attemptId,
  };

  // Violating: settle re-derives from the request it was handed.
  const violating = {
    settle: (req) => referenceComposition(req),
    refusal: () => snapshot.attemptId,
    replayLookup: () => snapshot.attemptId,
    challengeQuote: () => snapshot.attemptId,
  };

  const good = watched(settleTimeRequest());
  assert.equal(valueComparingRunner({
    ...compliant,
    settle: () => compliant.settle(good.proxy),
  }), true, 'compliant implementation agrees on all four paths');
  assert.deepEqual(good.reads, [], 'compliant settle reads nothing off the request');

  const bad = watched(settleTimeRequest());
  const valueVerdict = valueComparingRunner({
    ...violating,
    settle: () => violating.settle(bad.proxy),
  });

  assert.equal(valueVerdict, true,
    'NEG-3 precondition: the violating implementation still agrees on all four values — ' +
    'this is why a value-comparing runner reports conformance');
  assert.ok(bad.reads.length > 0,
    'and it did so by reading the request at settle time, which is the violation');

  // The fixture is only valid if the two are distinguishable by something other
  // than the value. Reading the request is that something.
  assert.notDeepEqual(bad.reads, good.reads,
    'NEG-3 fixture: value alone cannot separate these two; read-set can');
});

/* ------------------------------------------------------------------ *
 * NEG-3b — what the composition binds, and what it deliberately does not
 * ------------------------------------------------------------------ */

test('NEG-3 · the composition binds the offer, not the payload body', () => {
  const offer = {
    method: 'POST',
    url: 'https://api.example/buy',
    params: {},
    payTo: '0xabc',
    amount: '1',
    asset: 'USDC',
    scheme: 'exact',
  };

  const withBodyA = { ...offer, body: { nonce: 'a', signature: '0x01' } };
  const withBodyB = { ...offer, body: { nonce: 'b', signature: '0x02' } };

  assert.equal(
    referenceComposition(withBodyA),
    referenceComposition(withBodyB),
    'body sits outside `pickOfferFields()` by design: the identity is the offer, not the payload. ' +
    'A payload difference that does not move the offer is not a different attempt identity.',
  );

  // Control, so this test cannot pass by the composition being constant.
  assert.notEqual(
    referenceComposition(offer),
    referenceComposition({ ...offer, amount: '2' }),
    'a bound field must move the value',
  );
  assert.notEqual(
    referenceComposition(offer),
    referenceComposition({ ...offer, params: { tag: 'FIRST' } }),
    'query is bound — the 2026-08-25 query-not-bound defect stays fixed',
  );

  // Consequence, stated rather than implied: two payments of the same offer
  // share one identity. Separating them needs a field this composition does not
  // have (see x402#4215's `client_attempt_id`, deliberately kept out of
  // `attempt_binding`). Widening the whitelist is a §3.1 text change and
  // re-keys every published entry; it is not a local fix.
});

/* ------------------------------------------------------------------ *
 * NEG-4 — reachability: the check must fire, and must stop firing
 * ------------------------------------------------------------------ */

test('NEG-4 · the ingress-derivation check fires on a violation and stays quiet without one', () => {
  const snapshot = deriveIngressSnapshot(INGRESS_REQUEST);

  /**
   * The suite entry, exactly as §3.1 states it: conformant when settle resolves
   * the ingress value *and* resolves it without re-reading the request.
   */
  function check(settleImpl, request) {
    const { proxy, reads } = watched(request);
    const value = settleImpl(proxy);
    return { conformant: value === snapshot.attemptId && reads.length === 0, reads };
  }

  const violating = check((req) => referenceComposition(req), settleTimeRequest());
  assert.equal(violating.conformant, false, 'a re-deriving settle is non-conformant');
  assert.ok(violating.reads.length > 0, 'because it read the request');

  // Trigger off, check body unchanged: the same check on a settle that resolves
  // the snapshot must report conformance. If it did not, the check would be
  // constant-false and every vector behind it would cover nothing.
  const compliant = check(() => snapshot.attemptId, settleTimeRequest());
  assert.equal(compliant.conformant, true,
    'NEG-4: with the violation removed the check must pass — otherwise it was never reachable');
  assert.deepEqual(compliant.reads, []);

  // Both directions recorded in one place, so a future edit that hard-wires
  // either verdict fails here rather than silently emptying the suite.
  assert.notEqual(violating.conformant, compliant.conformant);
});
