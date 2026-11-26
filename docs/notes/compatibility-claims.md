# How to claim compatibility with SYCEE

A compatibility claim should be a measurement, not a declaration. This note
exists so that saying "compatible" is cheap and checkable — for the party making
the claim, and for whoever has to trust it later.

## Three kinds of compatibility

Being compatible is not one thing. Pick the one you actually do, and say which.

| Kind | What it means | How it is proved |
|---|---|---|
| **Verifier** | You can check a refusal row someone else produced: parse it, re-run the constructor, report the rule it broke. | `npx sycee-verify --conformance` → 76/76 |
| **Issuer** | Every row you emit is constructible from its own claims, across every reason, leg and settlement combination. | The same 76 vectors, with your constructor in place of ours |
| **Reconciler** | You can take a buyer row and a seller row about the same attempt, recompose the identity independently, and return `match` / `status_disagrees` / `only_buyer` / `only_seller`. | The identity vectors, plus a pair you did not produce yourself |

Most implementations are one of these three, not all three. Saying "compatible"
without naming the kind is the claim that costs everyone time later.

## Proving it

Zero install, no clone:

```
npx sycee-verify --conformance
```

The 76 vectors ship inside `sycee-verify`, so checking the claim costs one
command. Expected output ends with `76/76 passed` and exit code 0.

If you vendored the vectors instead, point at them directly:

```
npx sycee-verify --dir path/to/vectors --quiet
```

## What to write

A claim is useful only with three things attached: **which kind**, **which
version**, **checked when**. Copy this into your README:

```md
### SYCEE compatibility

This implementation is a **SYCEE 0.3 verifier**: it passes all 76 refusal-row
conformance vectors (`npx sycee-verify --conformance`), last checked
2026-11-26 against sycee-verify 0.3.1.

It is **not** an issuer: rows are read, never produced.
```

Two sentences. The first states what is true; the second states what is not.
The second one is what makes the first one worth reading.

## What does not count

- **Same field names, different meaning.** A row with `settlement` values that
  do not match the settled/pending/not_submitted/unknown set is not compatible,
  it is a lookalike.
- **Passing your own samples.** Vectors you wrote test what you thought of.
- **Passing an older vector set and claiming the current version.** Vectors are
  append-only within a minor version, so this is checkable — and it will be
  checked.
- **A logo without a version number.** Withdrawing a claim later is fine; a claim
  that cannot be dated cannot be withdrawn.

## What we owe you in return

A claim is only as stable as the thing it points at. So:

- **Vectors are append-only within a minor version.** A vector that passes today
  passes in 0.3.x. New vectors may be added; existing ones are not edited or
  removed.
- **Breaking changes require a major version**, and the changelog says which
  vector class it affects.
- **The bundled set is byte-identical to the conformance source** — a test fails
  if the two drift, so what `--conformance` runs is what the spec is tested
  against.

If any of these stop being true, the claim above is what breaks first, and that
is on us, not on you.

## Why bother

The point of a dated, graded claim is that a disagreement later has somewhere to
land. "We are both compatible, and we both pass the same 76 vectors" turns a
dispute into a bug report against a named version. "We are both compatible"
alone turns it into an argument.
