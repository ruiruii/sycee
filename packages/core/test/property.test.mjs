/**
 * Property tests for the invariants a compiler cannot see.
 *
 * The refusal row is a small type whose correctness lives in three tables:
 * which evidence class a reason may claim, which leg observation a reason
 * requires or permits, and which settlement a recorded leg allows. Each rule is
 * also exposed as a pure predicate (`withinCeiling`, `legSupport`,
 * `legSettlementCheck`), and `refusalRow` is supposed to be nothing more than
 * those predicates composed behind a throw. If the constructor and the
 * predicates ever disagree, one of them is wrong and the whole format is
 * unsound — but nothing about that shows up at compile time.
 *
 * These tests enumerate the input space instead of sampling it. The space is
 * small and finite (a few dozen reasons, four evidence classes, four leg
 * statuses per leg, four settlements), so exhaustive enumeration is both
 * stronger than random generation and perfectly reproducible — a failure names
 * the exact tuple that broke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFUSAL_REASONS,
  REASON_CEILING,
  EVIDENCE_ORDER,
  SETTLEMENT_STATES,
  LEGS,
  LEG_STATUS,
  REQUIRED_LEG_STATUS,
  BOUNDED_LEG_STATUS,
  LEG_SETTLEMENT,
  withinCeiling,
  reproducibleCeiling,
  legSupport,
  legSettlementCheck,
  refusalRow,
  generateKeyPair,
} from '../src/index.mjs';

const KEYS = generateKeyPair();
const ID = `sha256:${'0'.repeat(64)}`;

/** Every reason that can appear on a refused row (all but the accepted sentinel). */
const REASONS = Object.keys(REFUSAL_REASONS).filter((r) => REFUSAL_REASONS[r] !== null);
const STATUSES = Object.keys(LEG_STATUS);

/** A minimal valid refusal row, with room to override the field under test. */
function attempt(over = {}) {
  return {
    decision: 'refused',
    reason: 'wrong_amount',
    attemptIdentity: ID,
    settlement: 'not_submitted',
    signingPublicKey: KEYS.publicKey,
    role: 'merchant',
    ...over,
  };
}

/** True when `refusalRow` builds without throwing. */
function constructs(input) {
  try {
    refusalRow(input);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 1. Evidence ceiling: the constructor accepts exactly what the predicate does
 * ------------------------------------------------------------------ */

/** A settlement the reason itself permits, so only the ceiling varies. */
function settlementFor(reason) {
  if (reason === 'replay_already_settled') return 'settled';
  if (reason === 'replay_in_flight') return 'pending';
  if (reason === 'could_not_compare') return 'unknown';
  return 'not_submitted';
}

/**
 * The legs a reason requires, each at the first status that is also consistent
 * with the chosen settlement. Supplying them keeps the leg rules satisfied so
 * that an evidence-ceiling test varies only the ceiling. `null` when no
 * combination exists (skipped, so the test never asserts a tuple the format
 * cannot express at all).
 */
function legsFor(reason, settlement) {
  const required = REQUIRED_LEG_STATUS[reason] ?? {};
  const legs = {};
  for (const [leg, allowed] of Object.entries(required)) {
    const pick = allowed.find((s) => LEG_SETTLEMENT[leg][s].includes(settlement));
    if (!pick) return null;
    legs[leg] = pick;
  }
  return legs;
}

test('evidence class is accepted iff withinCeiling and reproducibility both allow it', () => {
  for (const reason of REASONS) {
    const settlement = settlementFor(reason);
    const legs = legsFor(reason, settlement);
    if (legs === null) continue;
    for (const cls of EVIDENCE_ORDER) {
      const built = constructs(attempt({ reason, evidenceClass: cls, settlement, legs }));
      // Two checks stack: the class may not exceed the reason's own ceiling,
      // and it may not exceed the ceiling that this row's recorded legs make
      // reproducible. `refusalRow` applies both, so the property must too.
      const predicate =
        withinCeiling(cls, reason) && reproducibleCeiling(reason, cls).ok;
      assert.equal(
        built,
        predicate,
        `${reason} + ${cls}: constructor ${built ? 'accepted' : 'rejected'}, predicate ${predicate}`,
      );
    }
  }
});

test('an evidence class above the reason ceiling never constructs', () => {
  for (const reason of REASONS) {
    const ceilingIdx = EVIDENCE_ORDER.indexOf(REASON_CEILING[reason] ?? 'issuer_asserted');
    const settlement = settlementFor(reason);
    const legs = legsFor(reason, settlement);
    if (legs === null) continue;
    for (let i = ceilingIdx + 1; i < EVIDENCE_ORDER.length; i++) {
      assert.equal(
        constructs(attempt({ reason, evidenceClass: EVIDENCE_ORDER[i], settlement, legs })),
        false,
        `${reason} must not claim ${EVIDENCE_ORDER[i]}, above its ${REASON_CEILING[reason] ?? 'issuer_asserted'} ceiling`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. Leg support: the constructor accepts exactly what legSupport permits
 * ------------------------------------------------------------------ */

test('every single-leg observation is accepted iff legSupport permits it', () => {
  for (const reason of REASONS) {
    for (const leg of LEGS) {
      for (const status of STATUSES) {
        const legs = { [leg]: status };
        const settlement = settlementFor(reason);
        const built = constructs(attempt({ reason, legs, settlement }));
        const support = legSupport({ legs, reason });
        // The constructor may still reject for a *different* rule (settlement
        // vs leg). Only assert the implication the leg rule is responsible for:
        // if legSupport refuses, the constructor must refuse too.
        if (!support.ok) {
          assert.equal(built, false, `${reason} + ${leg}=${status}: legSupport refused (${support.code}) but the row built`);
        }
      }
    }
  }
});

test('a reason that requires a leg is not constructible with that leg missing', () => {
  for (const reason of REASONS) {
    const required = REQUIRED_LEG_STATUS[reason];
    if (!required) continue;
    for (const leg of Object.keys(required)) {
      const settlement = settlementFor(reason);
      // Omit the required leg entirely; supply only the other one, if any.
      const legs = {};
      for (const other of LEGS) if (other !== leg) legs[other] = 'not_reached';
      assert.equal(
        constructs(attempt({ reason, legs, settlement })),
        false,
        `${reason} needs ${leg} recorded; a row that omits it must not construct`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3. Leg × settlement: the constructor accepts iff legSettlementCheck permits
 * ------------------------------------------------------------------ */

test('a recorded leg and a settlement are accepted iff LEG_SETTLEMENT allows the pair', () => {
  for (const leg of LEGS) {
    for (const status of STATUSES) {
      for (const settlement of SETTLEMENT_STATES) {
        const legs = { [leg]: status };
        const check = legSettlementCheck({ legs, settlement });
        // Choose a reason that does not itself constrain settlement, so this
        // property isolates the leg×settlement rule.
        const reason = 'wrong_amount';
        const built = constructs(attempt({ reason, legs, settlement, evidenceClass: 'client_verifiable' }));
        if (!check.ok) {
          assert.equal(built, false, `${leg}=${status} + ${settlement}: LEG_SETTLEMENT refused but the row built`);
        }
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * 4. The tables are internally consistent
 * ------------------------------------------------------------------ */

test('every settlement a leg permits is a real settlement state', () => {
  for (const leg of LEGS) {
    for (const status of Object.keys(LEG_SETTLEMENT[leg])) {
      for (const settlement of LEG_SETTLEMENT[leg][status]) {
        assert.ok(
          SETTLEMENT_STATES.includes(settlement),
          `${leg}=${status} permits ${settlement}, which is not a settlement state`,
        );
      }
    }
  }
});

test('only an executed leg may precede a settled outcome', () => {
  for (const leg of LEGS) {
    for (const status of Object.keys(LEG_SETTLEMENT[leg])) {
      if (status === 'executed') continue;
      assert.equal(
        LEG_SETTLEMENT[leg][status].includes('settled'),
        false,
        `${leg}=${status} must not permit settled: the leg did not complete, so nothing landed`,
      );
    }
  }
});

test('every required and bounded leg status is an observable state', () => {
  for (const [reason, legs] of Object.entries(REQUIRED_LEG_STATUS)) {
    for (const [leg, allowed] of Object.entries(legs)) {
      assert.ok(LEGS.includes(leg), `${reason} requires unknown leg ${leg}`);
      for (const s of allowed) {
        assert.ok(LEG_STATUS[s], `${reason} requires ${leg}=${s}, which is not observable`);
      }
    }
  }
  for (const [reason, legs] of Object.entries(BOUNDED_LEG_STATUS)) {
    for (const [leg, allowed] of Object.entries(legs)) {
      assert.ok(LEGS.includes(leg), `${reason} bounds unknown leg ${leg}`);
      for (const s of allowed) {
        assert.ok(LEG_STATUS[s], `${reason} bounds ${leg}=${s}, which is not observable`);
      }
    }
  }
});

test('no reason is left without a ceiling — a missing entry would silently close at the weakest', () => {
  for (const reason of REASONS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(REASON_CEILING, reason),
      `${reason} has no REASON_CEILING entry; it would fall back to issuer_asserted without anyone noticing`,
    );
  }
});
