# Section 15 known-answer vectors

Vectors for the refusal row defined in [`specs/extensions/refusal-row.md`](../../specs/extensions/refusal-row.md), and a judge that checks two implementations against them.

```
node conformance/refusal/judge.mjs --expect=48
```

Exit 0 means no violation. Exit 2 means the judge itself could not run, which is never a pass.

## Why vectors rather than tests

The unit tests in `packages/core/test/` answer "does the rule fire when it should". They cannot answer "can a wrong implementation pass". Those are different questions, and the second one is the one a reader of this spec actually cares about, because they are about to write their own implementation.

A concrete failure this format was built to catch: if a wrong file is only required to *differ* from its recorded value, then a checker that returns the same constant for every field passes every wrong file, for a reason unrelated to the rule under test. The same checker passes every right file too, since half the accepted vectors are `issuer_asserted` by design.

The fix is the **twin rule**. Every accepted vector has a `-wrong` twin carrying the same input and a plausible wrong answer. An implementation must compute, on the wrong file, the value its *right twin* records. Differing is not enough; differing for the right reason is.

## The files

`vectors/known-answer-*.json`, 48 files, sixteen of each kind.

**Accepted, 16** (`known-answer-<name>.json`) — a legal constructor input, the fields it must produce, and the wrong twin:

| file | what it pins down |
|---|---|
| `eip3009-nonce-spent` | one-leg scheme: the nonce is per-attempt, so the claim stays `chain_verifiable` |
| `permit2-transfer-reverted` | the drift state: authorization executed, transfer reverted, class closes at `issuer_asserted` |
| `facilitator-timeout-auth-unread` | no claim is made about the transfer leg, so none is recorded |
| `internal-error-no-legs` | omitting `legs` asserts nothing about either leg |
| `risk-policy-not-reached` | `not_reached` is the observation that makes a pre-submission refusal honest |
| `accepted-settled` | an accepted row asserts no reason and therefore no evidence class |
| `accepted-never-submitted` | `decision` and `settlement` are independent: an accepted attempt may never have reached the rail (§13) |
| `insufficient-funds-unread` | a `chain_verifiable`-shaped reason whose check is not reproducible, so the row closes at `issuer_asserted` |
| `pending-refusal-not-final` | a pending settlement is a legal row when it is not presented as final |
| `wrong-amount-refused` | a fact the client can check without trusting the merchant |
| `invalid-signature-refused` | the buyer can re-check the signature, so the class is `client_verifiable` |
| `wrong-recipient-refused` | the recipient is in the payload the buyer signed |
| `malformed-payload-refused` | a payload that would not decode is a fact the holder of the bytes can reproduce |
| `authorization-expired-refused` | an expired window with the authorization unread: the reason permits it |
| `nonce-spent-refused` | a spent nonce is a negative read on this attempt's own signature, so `chain_verifiable` survives |
| `duplicate-payment-refused` | the earlier settlement is public ledger state |

The last six exist because a reason's **default** class is a claim about who can check it. An implementation that gets the default wrong is wrong on every row it ever writes, and before this set was widened five of these reasons had no vector at all.

**Wrong twins, 16** (`known-answer-<name>-wrong.json`) — same input, one field answered wrongly. Among them: `issuer_asserted` where a third party can check, `chain_verifiable` where nobody can, `chain_verifiable` where the class is unreachable, an unread leg promoted to a settled one, and an evidence class attached to a row that asserts no reason.

**Rejected, 16** (`known-answer-reject-*.json`) — inputs no row should be constructible from, the code the constructor must fail with, and a `twin` naming an accepted file that differs in exactly one place:

`leg_contradicts_reason` (eight files: transfer recorded as executed; wrong amount with an executed authorization; a risk refusal after submission; an expired authorization recorded as executed; a spent nonce recorded as `not_reached`; `transfer_leg_failed` with the authorization unread; with the transfer unread; with the transfer never reached), `leg_not_observed`, `unknown_leg`, `unknown_leg_status`, `not_reproducible`, `finality_pending_is_not_final`, `bad_decision`, `bad_settlement`, `unreviewed_reason`.

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

**It is not an independent implementation, and this file used to imply that it was.** One person wrote the prose, the JavaScript, the vectors and the Python. Two implementations agreeing therefore shows that the author is consistent with himself. It does not show that the text can be read by someone else, and the check that does show it is the third reader below.

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

### Third reader

A reader written from the prose alone, by holistis, one sitting, guesses logged before the run:
[research/sycee-section-15-third-reader](https://github.com/holistis/agent-receipt-verify/tree/main/research/sycee-section-15-third-reader)
(2026-11-20, against commit `632c2f56`). It did not open either checker here.

First run, against the 25 files that existed then: 21 agree; all eight wrong twins differ from
their right twin. The four disagreements were resolved by changing this repository, not the
reader.

### What the four disagreements changed

Each one is a place where the text and the vectors said different things. In all four the reader
was right about the text.

**`reject-accepted-never-submitted` — the vector was wrong, and so was a unit test.** §13 lists
`accepted` + `not_submitted` as the output for a `purchase_not_settled` loser, and `classifyRepeat`
returns it for a first presentation. Meanwhile `finalityCheck` refused the pair, from a rule that
existed only in code, and `packages/core/test/refusal.test.mjs` asserted that refusal — so the
contradiction was three-deep: prose, constructor and test, all disagreeing with each other and
none of them failing. The file is now `accepted-never-submitted`, the rule is gone, and the test
asserts the opposite with a comment saying what it used to assert.

**`reject-risk-policy-after-submission` — the text was incomplete.** The reason was right and the
vector was right, but the table saying which leg statuses each reason permits lived only in
`packages/core/src/refusal.mjs`. A reader with the prose alone could not know it. That table is
now in §15.4, and this directory's copy is the one a reader cited.

**`permit2-transfer-unread` — the vector was wrong twice over.** Its name and note described a
leg that was submitted and not read; its fields recorded `transfer: failed` and
`authorization: unknown`. §5 defines `transfer_leg_failed` as a conjunction, and `unknown` on the
authorization does not satisfy it. It is now `reject-transfer-leg-failed-auth-unknown`, expecting
`leg_contradicts_reason`, and both implementations pin the authorization leg to `executed`.

**The fifteen planted mistakes that passed.** Of 21 plausible mistakes planted in a reader that
agreed with every file, 15 passed the set as it stood. That number — not the 21 of 25 — is the
one that measured this directory, because it asks what a wrong implementation can get away with
rather than what a careful one got right.

The set is now 40 files: eight new rejected vectors for the mistakes that were passing, and four
new accepted vectors with their wrong twins, because three of those mistakes were only reachable
through a row the set had no example of. The one worth naming: `transfer_leg_failed` with
`transfer: unknown` passed before, and §15.7 claimed a mutant covered it — the only vector that
could have covered it recorded the transfer as `failed` instead, so the rule was asserted and
never tested.
