"""Ed25519 verification for SYCEE VSR envelopes.

SPEC.md §6.1 and §7.3: ``signer.public_key`` is ``ed25519:<base64 SPKI DER>``
and the signature is base64url (RFC 4648 §5, no padding) over the canonical
bytes of the ``vsr`` object.

``cryptography`` is preferred; PyNaCl is accepted as a fallback so the
verifier still works on hosts that only ship libsodium bindings.
"""

from __future__ import annotations

import base64
import re

_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")
_SPKI_ED25519_PREFIX = bytes.fromhex("302a300506032b6570032100")

try:  # pragma: no cover - which branch is taken depends on the environment
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.hazmat.primitives.serialization import load_der_public_key

    BACKEND = "cryptography"
except ImportError:  # pragma: no cover
    Ed25519PublicKey = None
    try:
        from nacl.exceptions import BadSignatureError
        from nacl.signing import VerifyKey

        BACKEND = "pynacl"
    except ImportError:
        VerifyKey = None
        BACKEND = None


class SignatureError(ValueError):
    """The key or signature is malformed, or the signature does not verify."""


def decode_base64url(text: str) -> bytes:
    """Strictly decode unpadded base64url (SPEC.md §3 notation)."""
    if not isinstance(text, str) or not _B64URL_RE.match(text):
        raise SignatureError("not base64url")
    padded = text + "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, TypeError) as exc:
        raise SignatureError(f"invalid base64url: {exc}") from exc


def _raw_public_key(reference: str) -> bytes:
    if not isinstance(reference, str) or not reference.startswith("ed25519:"):
        raise SignatureError("public_key must start with 'ed25519:'")
    der = decode_base64url(reference[len("ed25519:") :])
    if len(der) == 32:  # bare key, not wrapped in SPKI
        return der
    if len(der) == 44 and der.startswith(_SPKI_ED25519_PREFIX):
        return der[len(_SPKI_ED25519_PREFIX) :]
    raise SignatureError("public_key is not an Ed25519 SPKI key")


def verify(public_key: str, message: bytes, signature_b64: str) -> bool:
    """Return True iff ``signature_b64`` verifies over ``message``.

    Raises :class:`SignatureError` for malformed keys or signatures; a
    well-formed signature that simply does not match returns False.
    """
    if BACKEND is None:
        raise SignatureError(
            "no Ed25519 backend available: install 'cryptography' or 'PyNaCl'"
        )

    raw_key = _raw_public_key(public_key)
    signature = decode_base64url(signature_b64)
    if len(signature) != 64:
        raise SignatureError(f"Ed25519 signature must be 64 bytes, got {len(signature)}")

    if BACKEND == "cryptography":
        key = Ed25519PublicKey.from_public_bytes(raw_key)
        try:
            key.verify(signature, message)
        except InvalidSignature:
            return False
        return True

    key = VerifyKey(raw_key)  # pragma: no cover - PyNaCl fallback
    try:
        key.verify(message, signature)
    except BadSignatureError:
        return False
    return True
