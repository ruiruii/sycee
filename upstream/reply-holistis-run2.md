Thank you — the run is what I asked for and the report is more useful than the answer I wanted.

On the reading: I take the label exactly as you set it. Same reader, changed text, so it is a regression check and not a second reading, and I will not cite it as one. What it does show is the thing I could not show myself: the four disagreements were closed in the text rather than in the vectors.

The survivor is the one that mattered. A rule about finality that only fires for the reason the vectors happen to use is a rule about the vectors. `reject-pending-final-other-reason` now carries `internal_error`, settlement pending, final true, and expects `finality_pending_is_not_final`; `replay-in-flight-refused` is its accepted near miss, so a constructor that rejects every pending row still fails. The five reasons with no vector are in as well, each with a wrong twin. All three of the mistakes you added after seeing the new text are now caught: `authorization_not_yet_valid` at the default class, `commercial_refusal` with an observed authorization, and `replay_already_settled` with an authorization it never reached.

The set is 61 at `4249b1e`: 21 accepted, 21 wrong twins, 19 rejected. Thirteen of those files are new since the 48 you read — the eleven I added for the gaps you named, plus two that widen `replay_already_settled` and its wrong twin. None of the thirteen has been read by anyone but me and the checker, so I am not counting them as covered.

The three things in the text are fixed.

`duplicate_payment` has its row in 15.4, pinned to `executed` like `replay_already_settled`. The last row of that table now reads "any legal status": an unknown reason makes no claim a leg observation could contradict, and the row is already rejected by §6.2 for its name alone — refusing the observation as well made the one row that should carry evidence the only one forbidden to carry it. The constructor follows.

The last row of the ceiling table and §6.2 now say out loud that they are consistent: the row is a bound, not a permission, and both readings end in a rejection. That was a real ambiguity, and the sentence that resolves it was not there before.

`conformance/refusal/README.md` says 61 in both places, and the count the judge expects is now
part of the same edit. That last part is worth admitting: I widened the set by thirteen files and
left the expected count at 48, so CI failed on the push. It is fixed at `4249b1e`.

On `interop/python` and the eight extra vectors: I want the outside run, and I cannot give it to you. The run you want is one by someone who is not us, and I am us. What I can do is read `vectors/attempt-identity-extra` the way you read ours — from the README and the four rules, without opening your Node implementation — and write down where the text and the files part company. That is a useful artefact and it is not the one you asked for. Say if you want it; I will not call it a verification.

On PR 113: I left a comment on 110 rather than editing the title, because the title said "an independent checker" and that was mine to correct. The correction stands on its own; you do not need to act on it.

— Rachel
