# SYCEE — merchant staging note

Half a page, for a merchant who already runs x402 and asks "what would I change".
Nothing here is a spec; everything here is a diff you can eyeball in five minutes.

## What you add

On the **success path only**, sign one more thing you already know:

- `redeem_count` — how many times this payment proof was accepted (you already dedup;
  this is just the count, written down).
- delivery fields — did the bytes arrive, and when.

That is it. One signed field you can compute from state you already hold, and one
you already observe on every `200`.

## What you do **not** touch

- Your rail. No new chain, no new token, no new account.
- Your facilitator. The payment flow is unchanged.
- Your funds. No custody, no escrow, no address change.

A merchant's first fear is "you want me to rebuild my payment stack". You don't.
You add a signature to a path you already own.

## How you verify it

```bash
npx sycee-verify receipt.json
```

No clone, no install step — `npx` fetches the verifier and runs it. It prints
`PASS` / `FAIL` and, on failure, which rule and why. The same command is what a
buyer's verifier runs, so "it passes on my machine" is the thing that travels.
(Working inside this repo? `node bin/sycee-verify.mjs receipt.json` is the same
checker, no fetch needed.)

## What "staging worked" looks like — one sentence

A settled attempt and its refused replay come back as one row each, with the same
identity and a different `presentation`, and `npx sycee-verify` says both are valid.

## Where to read more, if you want

[`SPEC.md` §5.5](../SPEC.md) is the refusal-record section; the field set is
[`specs/extensions/refusal-row.md` §4](../specs/extensions/refusal-row.md).
Neither is required reading before you try the one command above.
