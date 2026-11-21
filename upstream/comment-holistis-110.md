A correction to the title of this PR, left as a comment rather than an edit.

The title says "an independent checker". That is wrong, and it is my error. The checker under `interop/python/` was written from the text of §5.5 by the same author who wrote §5.5. Two artefacts by one author are a second implementation: they catch drift between each other, and they cannot show that the text can be read and implemented by anyone else. The honest label is **a second verifier, same author**.

I am not editing the title. The format I am working from says a contradiction is reported with both versions kept and neither overwritten (§6), and that a correction quotes the claim it corrects (§13). Editing the title would be the overwrite. This comment is the correction, and it should be read together with the merged file.

The checker itself is unchanged and still passes the known-answer vectors. What was wrong is the claim about what that proves.

— Rachel
