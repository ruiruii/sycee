# Section 15 known-answer vectors

Vectors for the refusal row defined in [`specs/extensions/refusal-row.md`](../../specs/extensions/refusal-row.md), and a judge that checks two independent implementations against them.

```
node conformance/refusal/judge.mjs --expect=25
```

Exit 0 means no violation. Exit 2 means the judge itself could not run, which is never a pass.

## Why vectors rather than tests

The unit tests in `packages/core/test/` answer "does the rule fire when it should". They cannot answer "can a wrong implementation pass". Those are different questions, and the second one is the one a reader of this spec actually cares about, because they are about to write their own implementation.

A concrete failure this format was built to catch: if a wrong file is only required to *differ* from its recorded value, then a checker that returns the same constant for every field passes every wrong file, for a reason unrelated to the rule under test. The same checker passes every right file too, since half the accepted vectors are `issuer_asserted` by design.

The fix is the **twin rule**. Every accepted vector has a `-wrong` twin carrying the same input and a plausible wrong answer. An implementation must compute, on the wrong file, the value its *right twin* records. Differing is not enough; differing for the right reason is.

## The files

`vectors/known-answer-*.json`, 25 files in three kinds.

**Accepted, 8** (`known-answer-<name>.json`) — a legal constructor input, the fields it must produce, and the wrong twin:

| file | what it pins down |
|---|---|
| `eip3009-nonce-spent` | one-leg scheme: the nonce is per-attempt, so the claim stays `chain_verifiable` |
| `permit2-transfer-reverted` | the drift state: authorization executed, transfer reverted, class closes at `issuer_asserted` |
| `permit2-transfer-unread` | the authorization leg was submitted and read as nothing: honest silence |
| `facilitator-timeout-auth-unread` | no claim is made about the transfer leg, so none is recorded |
| `wrong-amount-refused` | a fact the client can check without trusting the merchant |
| `internal-error-no-legs` | omitting `legs` asserts nothing about either leg |
| `risk-policy-not-reached` | `not_reached` is the observation that makes a pre-submission refusal honest |
| `accepted-settled` | an accepted row asserts no reason and therefore no evidence class |

**Wrong twins, 8** (`known-answer-<name>-wrong.json`) — same input, one field answered wrongly. Among them: `issuer_asserted` where a third party can check, `chain_verifiable` where nobody can, an unread leg promoted to a settled one, and an evidence class attached to a row that asserts no reason.

**Rejected, 9** (`known-answer-reject-*.json`) — inputs no row should be constructible from, the code the constructor must fail with, and a `twin` naming an accepted file that differs in exactly one place:

`leg_contradicts_reason` (transfer recorded as executed; wrong amount with an executed authorization; a risk refusal after submission), `leg_not_observed`, `unknown_leg`, `unknown_leg_status`, `not_reproducible`, `finality_pending_is_not_final`, `finality_accepted_not_submitted`.

The rejected family exists because the accepted family alone cannot catch a constructor that accepts everything. Each rejected file's near-miss twin is accepted, so a constructor that refuses everything fails as well.

## The judge

`judge.mjs` runs two implementations over the same files and applies eight rules.

| rule | asks |
|---|---|
| `SET` | the set is complete: pairs, twins, near misses, count |
| `ALIGN` | both returned the same fields in the same order |
| `R1` | a wrong file's value really differs from its twin's — a file that tests nothing is a fault |
| `R2` | the two implementations agree on every field |
| `R3` | on an accepted file both compute the recorded value |
| `R4` | on a wrong file both compute what the right twin records |
| `R5` | on a rejected file both refuse with the recorded code, and the near miss is accepted |
| `R6` | the judge catches four degenerate implementations fed to it directly |

`R6` is the rule that makes the rest worth reading. The judge is a pure function, so the test suite can hand it a constant, an accept-everything, a refuse-everything, and the plausible mistake (taking the reason's base ceiling as the default), and require a violation for each. A judge that has only ever seen correct input has been run, not tested.

## The two implementations

| | |
|---|---|
| `verify-known-answers.mjs` | calls the JavaScript constructor in `packages/core/src/refusal.mjs` |
| `verify_known_answers.py` | written from the prose of §5 and §15, standard library only, imports nothing from the JavaScript |

The Python checker exists to make disagreement possible. It was written after the vectors, from the text alone; where it and the JavaScript disagree, the disagreement is the finding, not a bug to be silenced by copying one into the other.

Both emit the same shape:

```json
[{"id": "...", "outcome": "ACCEPT", "fields": [{"field": "evidence_class", "computed": "issuer_asserted"}]},
 {"id": "...", "outcome": "REJECT", "code": "leg_not_observed"}]
```

## Citing

```
gates-spec, conformance/refusal, 2026-11-20.
```

The format of this directory — known-answer files, wrong twins, a pure judge, a degenerate-implementation self-test — follows `interop/` in [holistis/agent-receipt-verify](https://github.com/holistis/agent-receipt-verify), where the twin rule was first written down. The vectors and both checkers here are independent of that repository; the shape is not.
