"""Independent Python verifier for SYCEE VSR envelopes.

Implements SPEC.md only: canonical JSON (§7.1), Ed25519 verification (§7.3),
and the field/semantic rules of §5.3, §5.6, §6 and §6.1. It does not sign,
and it does not import the JavaScript reference implementation.
"""

from .canonical import CanonicalizationError, canonical_bytes, canonical_json
from .signing import BACKEND as ED25519_BACKEND
from .verify import (
    Issue,
    Report,
    SCHEMA_VERSION,
    settlement_consistency,
    verify_envelope,
)

__all__ = [
    "CanonicalizationError",
    "ED25519_BACKEND",
    "Issue",
    "Report",
    "SCHEMA_VERSION",
    "canonical_bytes",
    "canonical_json",
    "settlement_consistency",
    "verify_envelope",
]

__version__ = "0.1.0"
