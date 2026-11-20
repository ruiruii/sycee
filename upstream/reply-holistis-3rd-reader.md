All four are fixed at `df240da`, and you were right about the text in every one of them.

Three of the four turned out to be this repository contradicting itself, and one went deeper than your report could see from outside.

**`accepted` + `not_submitted`.** §13 lists the pair as the output for a `purchase_not_settled` loser. `classifyRepeat()` returns it for a first presentation — so the ordinary first purchase, the most common row there is. `finalityCheck()` refused the pair, from a rule that existed only in code. And a unit test asserted that refusal. Four places, three of them disagreeing, none of them failing, because no test ever called the two halves in sequence. The rule is gone, the test now asserts the opposite and carries a comment saying what it used to assert, and the vector is accepted.

**`transfer_leg_failed`.** Your reading was the right one: both implementations allowed `authorization: unknown` while §5 defines the reason as a conjunction. Both pin it to `executed` now. Worth adding what you could not see: the vector that used the looser form was inconsistent with itself — its name and note described an unread leg, its fields recorded a failed one. That is why the set had no example of `transfer: unknown` anywhere, and therefore why the mutant §15.7 names was passing. One bad field, two holes.

**`risk_policy_rejected`.** `REQUIRED_LEG_STATUS` was in the constructor and nowhere else, exactly as you said. It is a table in §15.4 now, with the pinned and the unpinned rows both written out.

**Two more, found while checking your list.** `duplicate_payment` was in §5's closed set and missing from the reason enum in the code, so that reason could not be constructed at all — a reader implementing §5 faithfully would have been rejected by the reference implementation. And §5 said six reasons described a repeat presentation when the table listed three.

**The set is 48 files now** — 16 accepted, 16 wrong twins, 16 rejected. I took the fifteen mistakes of yours that passed and built one mutant per mistake against the new set: all fifteen are caught, checked one at a time rather than as a batch. The six you had already seen fail still fail.

Half of the growth is your list and half is what the list implied. The new accepted vectors are reasons that had no vector at all — `invalid_signature`, `wrong_recipient`, `malformed_payload`, `duplicate_payment`, `authorization_expired`, `insufficient_funds`. A default evidence class is wrong on every row an implementation ever writes, and five of those defaults were untested.

**One structural change.** `conformance/refusal/docs-parity.mjs` reads the reason set and the leg contract out of the markdown and diffs them against the constructor's tables, on every push. I broke each side deliberately to confirm it fails. This is the check that would have caught two of your four without anyone reading anything.

**And a correction to our own wording.** The Python checker was described as an independent verifier in four places. One person wrote the prose, the JavaScript, the vectors and the Python. Two implementations agreeing shows the author is consistent with himself; your report is the only evidence we have that the text can be read by someone else. It says `second verifier, same author` now.

**The ask, which is the same ask as last time.** Would you run the reader against `df240da`, 48 files? Most of your reader stands as written: the leg contract is stricter, the discarded rule is gone, and the count moved. What I want to know is whether the fifteen holes are actually closed, because my own check of that is still my own check. If you would rather keep it to a spot check, the four files I would pick are `reject-transfer-leg-failed-transfer-unknown`, `insufficient-funds-unread`, `accepted-never-submitted`, and `pending-refusal-not-final`.

Your guess log is the part I would ask anyone to read first, by the way. Not the score — the log. It shows exactly where the prose stopped deciding and a reader had to choose, which is the measurement we did not know how to take.

— Rachel
