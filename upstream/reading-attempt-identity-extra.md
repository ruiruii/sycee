# Reading `vectors/attempt-identity-extra`

**Same-author reading.** 2026-11-22, folder at `main` (last folder commit `c2add1c`, 2026-11-20).
Reader: Rachel (`ruiruii`).

**Opened:** the folder `README.md`, the eight `known-answer-*.json`, `SHA256SUMS`, and §5.5 as
each file's `provenance` cites it.
**Not opened:** `src/canonical-request.mjs`, `interop/python`, `test/`, `scripts/seal-vectors.mjs`.

The label is "same-author reading" because I read the README first, and the README states the four
rules. That is also what keeps it from being a second reading: one reader, one text, where the text
includes the explanation. What it can show is narrower than a verification and wider than a
regression check — whether the eight values follow from the rules as written, for someone who has
never seen the code.

## Method

Python 3.11, standard library only, written from the README's four rules and from nothing in the
implementation:

1. base64 → bytes; split `Content-Encoding` on commas; undo from the last to the first; `deflate`
   is the zlib format (RFC 1950), not raw deflate.
2. Decode with the charset named in `Content-Type`, names matched ASCII case-insensitively; no
   charset means UTF-8; re-encode as UTF-8.
3. If the media type is `application/json` or ends in `+json`, parse and re-serialise per RFC 8785
   (keys sorted by UTF-16 code unit, ECMAScript number formatting).
4. SHA-256 over those bytes.

## Result

| pair | right value | reproduced | wrong value | equals its named mistake |
|---|---|---|---|---|
| `body-deflate-then-rfc8785` | `bf20ad18…` | yes | `641647b2…` | yes — inflated, hashed without RFC 8785 |
| `body-content-encodings-reversed-in-order` | `bf20ad18…` | yes | `0086de05…` | yes — the bytes as transmitted |
| `body-charset-name-is-case-insensitive` | `27d073d0…` | yes | `e66baa59…` | yes — 0x80 read as windows-1252 |
| `body-plus-json-media-type-is-json` | `d3626ac3…` | yes | `43138fc0…` | yes — the body hashed as written |

Four of four right values, four of four wrong values. All eight files match `SHA256SUMS`. Each
wrong twin carries a byte-identical input to its right twin, so the pair discriminates the rule and
not merely "a different number" — the construction the 22 use, and it holds here.

That is the whole of the good news and it is most of the answer.

## Where the text and the files part company

### 1. `provenance` cites a text that cannot produce the value

Every file's first provenance line cites §5.5 of PR 3776 and "the same text as the 22 frozen files".
The four rules are not in §5.5. They are settled by RFC 9110 (the codings are listed in the order
applied; `deflate` is zlib) and RFC 6839 (the `+json` suffix), and by the charset registry for the
name. The README says this outright — "it does not spell out these four cases itself" — but
`provenance` is the field a consumer reads without the README, and it names one source where there
are three. Adding the RFCs is one line per file and makes the file true on its own.

### 2. The seal covers the values, not the rules

`SHA256SUMS` lists eight `*.json` and nothing else. The README — the only place the four rules are
written — is outside it, so `sha256sum -c` passes while someone rewrites the rules. The 22 do not
have this shape: their rule is §5.5 at commit `2819ed7`, an anchor outside the folder that git can
verify. The eight have a README and a tag, and the tag pins a different object than the rule.

### 3. The charset pair changes two variables, so it does not isolate case

The README says: "The existing file for ISO-8859-1 uses a lower-case name; this one adds the
capitals." The existing file (`known-answer-body-iso-8859-1-is-latin1`, one of the 22) has the body
`\x80A`. This one has `caf\xe9 \x80`. The body changed too, so there is no file that holds the body
fixed and changes only the case, and a failure on this file cannot be attributed to case.

If the intent is case alone, the file is `caf\xe9 \x80` with `charset=iso-8859-1` and the same
`27d073d0…`. Without it, the claim "case-insensitivity is pinned" is pinned jointly with a body
that no other file shares.

### 4. The 0x80 question is not RFC 2978's, and two live standards answer it differently

The README credits this pair to "RFC 2978 for charset names that do not depend on case". RFC 2978
settles the name. The mapping is a different question, and it has two published answers:

- **WHATWG Encoding** lists `iso-8859-1` as a label of windows-1252, and says of it: "any software
  following this standard will, for example, decode 0x80 as U+20AC (€)".
- **ICU 76.1**, which is what Node 22 in this environment uses, returns `U+0080` for the same label
  and byte.

So the value the file calls "a plausible wrong answer" is what a browser, or Deno, computes while
following a standard. The value recorded is right for the reading §5.5 wants — §5.5 says "decode the
charset", and the charset named is ISO-8859-1 — but `encodes` blames a mistake where a compliant
implementation on another platform would be making a choice. If a web-platform implementation is in
scope, this file will fail it and the diagnosis will point at the wrong thing.

This is the one finding I would call substantive. The other three are paperwork.

### 5. "Four of the 8 stay open" reads as four files

It means four of the eight *mistakes*: empty query segments, an invalid body for its declared
charset, the `x-gzip` alias, brotli. Read literally it says half the folder is unfinished.

### 6. One README row names two mistakes, the twin pins one

`body-content-encodings-reversed-in-order` is credited with catching "the order not reversed, or the
transmitted bytes hashed". The twin pins the second. The first cannot produce a value at all —
applying the undos in the listed order throws on the gzip bytes — so it is caught by a crash rather
than by a vector. Fine, but the table reads as if both are pinned.

## What this shows, and what it does not

**Shows:** the eight values follow from the four rules, for an implementation that has never seen
yours; and each wrong twin is exactly its named mistake, so the pairs test the rule rather than the
number.

**Does not show:** that §5.5 can be read and implemented by someone who has not read the README.
Three of the four rules need RFC 9110 and RFC 6839 alongside it, and the fourth needs a decision
that those documents do not make. That is the gap the label already names, and it is wider than
"same author" suggests: it is same author *and* the same explanation of the rules.
