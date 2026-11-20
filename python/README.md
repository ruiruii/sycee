# sycee-verify (Python)

A second verifier for SYCEE v0.1 VSR envelopes, written in Python from the
normative text of `SPEC.md`. It does not import or call the JavaScript
implementation in `packages/`, and it shares no code with it.

**"Second" rather than "independent".** Both implementations were written by the
same author, so their agreeing shows that the author is consistent with himself.
It does not show that a reader who has only `SPEC.md` reaches the same answer —
for that, see the third reader credited in `conformance/refusal/README.md`.

It verifies; it never signs.

## Dependencies

Ed25519 comes from `cryptography` (preferred) or `PyNaCl`:

```bash
pip3 install cryptography     # or: pip3 install pynacl
```

No other third-party packages are required.

## Usage

```bash
PYTHONPATH=python python3 -m sycee_verify conformance/vectors/*.json
python3 -m unittest discover python/tests      # or: python3 -m pytest
```

With no arguments the CLI locates `conformance/vectors` relative to this
repository. It prints one `PASS`/`FAIL` line per envelope with its level
(`L0`, `L1`, `L2` or `invalid`), a summary line, and exits `0` on success or
`1` otherwise. After `pip3 install -e python`, `python3 -m sycee_verify` works
from the repository root without `PYTHONPATH`, and the `sycee-verify` console
script is available.

## Parity

This implementation and the JavaScript reference return the same verdict for all
12 conformance vectors (7 valid, 5 rejected), including the `L0`/`L1`/`L2` level
of every file. They were written by one author, so read that as parity, not as
independent confirmation.

## Known boundaries

- **Verification only.** There is no signer, no key generation, and no
  canonicalization-to-signature path.
- **`completeness: bilateral` is a claim.** A VSR carries a single
  `signature` field and no co-signature slot, so the co-signed result block
  cannot be checked from the envelope. The verifier therefore treats
  `bilateral` as the only state in which a merchant-signed `consumed = yes|no`
  is allowed (§5.3, §10 L2). This reading is required by the
  `valid-consumed-yes` and `valid-redeem-count-3` vectors.
- **Raw-proof detection is pattern-based.** Keys such as `payment_proof` and
  values carrying `PAYMENT-SIGNATURE` or `X-PAYMENT` are rejected (§6). An
  arbitrary opaque blob cannot be identified as a payment proof body.
- **The public key comes from the envelope** (§7.3), so a pass proves internal
  consistency and possession of the matching key, not the issuer's identity.
  Payee binding (§5.5.6) is not checked: the envelope carries no payee address.
- **Scope.** Only VSR envelopes are handled. Refusal rows and portable claims
  (§5.5) are out of scope. Field checks implement the VSR schema explicitly
  rather than being a general JSON Schema engine.
- **Missing `settlement_status`** is read as `in_flight`, per §5.1: "not yet
  observable" is not "not settled".
