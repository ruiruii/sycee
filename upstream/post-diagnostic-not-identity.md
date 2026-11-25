Distribution plan for `docs/notes/diagnostic-not-identity.md`.
Three pieces, same core claim: a diagnostic is a copy of the answer, not a
second key to the answer. Publish the formal text on GitHub; use #4116 and X
as distribution hooks. Nothing here has been posted yet.

---

## 1. GitHub — formal note (the permanent, citable copy)

File: `docs/notes/diagnostic-not-identity.md`
Commit it, then use the permalink (commit-pinned URL) in the two hooks below.

Why GitHub: citable, reviewable, and it sits next to SPEC.md and the code, so a
reader can check the claim against the actual rule. Not a spec change — a note.

---

## 2. x402 #4116 — short comment with link (5 sentences)

> The trust question here is the general one: when one party publishes values
> for a verifier to check against, what stops the check from becoming agreement?
> We hit this with attempt identity — we publish `x-sycee-members` (one digest per
> member) but explicitly forbid a buyer from adopting those values as its
> identity, because adopting them makes every comparison pass by construction,
> including when a proxy rewrote `origin` or `path`. The buyer recomputes from
> the request it sent and the 402 challenge it received — before the response
> (and the header) arrives. Wrote up why a diagnostic must stay a diagnostic, in
> case it's useful to this thread: [permalink]. Not proposing this as the RFC's
> receipt scheme — a signed commitment to the response body is a different and
> stronger artifact where a body exists. This is a constraint on any
> "one side attests, the other verifies" design.

Note: the thread does NOT contain a literal argument for "diagnostic as second
identity key". This is framed as a general design constraint relevant to the
thread's trust question, not as a reply to someone's stated position. If it
reads as reply-to-a-ghost, drop it and leave only the GitHub note.

---

## 3. X — hook only (243 chars + link = 267, within the 280 free-tier limit)

> A diagnostic header that exposes every identity member is useful — until
> someone adopts it as the identity itself. Then every comparison passes by
> construction, and the verifier can't see what it exists to catch.
>
> Why we keep the two separate: [link]

Do NOT paste the note body into X — it will not fit and will not be read.
Link goes to the commit-pinned GitHub note.

---

## 4. Image — two-column comparison (SVG)

File: `docs/notes/diagnostic-not-identity.svg`
Left (red, "ADOPT"): buyer copies the published members → compares value to
itself → every row matches → a proxy rewrote `origin` and nobody sees it.
Right (green, "COMPOSE"): buyer recomputes before the response → nine members
compared independently → divergence located at `origin`.

Bottom line: "A diagnostic is a copy of the answer, not a second key to it."

Attach this SVG to the X post. Text is real SVG text (not AI-generated image
text), so it renders legibly at any size and says exactly what we intend.
