Following up on my earlier note, with one concrete question rather than a new argument.

I went to read the transactions behind the 1 November crossing, because a claim with hashes is
worth more than a claim without them, and because I would rather cite your run than construct a
negative case of my own.

The Tempo side reads, cleanly:

- purchase 1 — `0xb29cc90e…3bacd6`, block 46,848,176, 2026-11-01T01:16:03Z
- purchase 2 — `0x8bad4587…865493`, block 46,946,855, 2026-11-01T16:14:21Z
- reverse — `0x1bed21ae…8deaba`, block 46,974,328, 2026-11-01T20:24:46Z

All three Success, all three on 1 Nov, in the order the announcement gives them, and the reverse
one pays back to the same address that paid in the first two.

**The Solana side I could not read, and the case that matters is the one from your README rather
than the Slack screenshot.**

`README.md`, in the `/tempo/buy` section, says:

> our payment to the service on Solana was
> `HVcNrcGb9RZixMG5SLgp238KR9q1aBM38Q5tyJrt3fucrDmoTkvF6kNNkZfwL9foUWjS5PHMGA5rrU8SSqQ5zF3`, and
> both are on chain to read

On mainnet, `getSignatureStatuses` with `searchTransactionHistory: true` returns `null` for that
signature, and `getTransaction` returns `null`. Same node answers `finalized` for a signature I
took from a block of the same vintage, so the query works and the history is being served.

Two things I want to be careful about:

1. **I am not reading this as "the transaction does not exist."** One public RPC returning null is
   a weak reason to doubt someone's payment, and I could not reach a second independent node from
   where I am. A wrong conclusion here is worse than no conclusion.
2. **The two hashes in the Slack message I do hold loosely.** They are 87 and 88 characters and one
   has a space in it, which reads like a copy from a rendered message rather than a copy from a
   file. The README signature is different: it came out of a `.md`, and it is the one that does
   not resolve.

**The question.** Can you paste the Solana signature for the reverse crossing, taken from the code
path that produces it rather than from the README? If the README one is stale or was hand-edited,
that is a one-line fix and a useful answer. If it is correct and my read is wrong, I would like to
know which node sees it, because then my tooling is broken and I should fix that before citing
anyone.

There is a second thing I noticed while looking, and I would rather ask about it than assert it.
Your published x402 quote names a `payTo` of `8HdCdZ1Vao3uDazrVLxatDJawNckdBw5Aa9hTw7Z12V`. That
address exists on mainnet, but it is a System Program account holding only a rent balance, with no
signature history at all. An empty history is exactly what a newly funded address looks like, and
also exactly what an address that was never paid looks like; from outside I cannot tell those
apart. If it is the former, nothing follows. If the quote is served from a config that is not the
one taking payment, that is worth a look before real volume arrives.

None of this needs to change my original question about the 32 refunded. If anything, it makes the
answer more useful: a router whose crossings can be checked from outside is exactly the kind of
source a vector set should be able to point at, and I would rather link your explorer than describe
a hypothetical.

— Rachel
