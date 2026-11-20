"""Canonical JSON serialization for SYCEE VSR envelopes.

Implements the rules in SPEC.md §7.1 (which follows RFC 8785 / JCS):

1. UTF-8, no insignificant whitespace, no trailing newline.
2. Object keys sorted lexicographically by Unicode code point, recursively.
3. Array order preserved.
4. Numbers use the shortest round-trippable ECMAScript representation
   ("Number::toString"). Monetary amounts stay strings, as SPEC.md advises.
5. No trailing newline.

The signature covers the canonical form of the ``vsr`` object only
(SPEC.md §6.2); the ``signature`` field is never part of the input.
"""

from __future__ import annotations

import json
import math
from typing import Any


class CanonicalizationError(ValueError):
    """Raised when a value has no canonical JSON representation."""


def canonical_json(value: Any) -> str:
    """Return the canonical JSON text for ``value`` (SPEC.md §7.1)."""
    return _serialize(value)


def canonical_bytes(value: Any) -> bytes:
    """Return the canonical JSON text as UTF-8 bytes."""
    return _serialize(value).encode("utf-8")


def _serialize(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _serialize_string(value)
    if isinstance(value, int):
        return _serialize_integer(value)
    if isinstance(value, float):
        return _serialize_float(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_serialize(item) for item in value) + "]"
    if isinstance(value, dict):
        return _serialize_object(value)
    raise CanonicalizationError(f"unsupported type: {type(value).__name__}")


def _serialize_string(value: str) -> str:
    # RFC 8785 forbids unpaired surrogates: they cannot be encoded as UTF-8.
    for char in value:
        if 0xD800 <= ord(char) <= 0xDFFF:
            raise CanonicalizationError("lone surrogate in string")
    # json.dumps gives the required escaping for quote, backslash and C0
    # controls, and leaves non-ASCII characters as raw UTF-8.
    return json.dumps(value, ensure_ascii=False)


def _serialize_object(value: dict) -> str:
    for key in value:
        if not isinstance(key, str):
            raise CanonicalizationError("object keys must be strings")
    # SPEC.md §7.1 sorts by code point. Python's str ordering does exactly that.
    parts = [
        _serialize_string(key) + ":" + _serialize(value[key])
        for key in sorted(value)
    ]
    return "{" + ",".join(parts) + "}"


def _serialize_integer(value: int) -> str:
    # Beyond the I-JSON safe range ECMAScript no longer prints an exact
    # integer, so fall through to the double formatting path.
    if abs(value) <= 2**53 - 1:
        return str(value)
    try:
        return _serialize_float(float(value))
    except OverflowError as exc:
        raise CanonicalizationError("integer out of range") from exc


def _serialize_float(value: float) -> str:
    if not math.isfinite(value):
        raise CanonicalizationError("non-finite number")
    if value == 0:
        # ECMAScript String(-0) is "0".
        return "0"

    sign = "-" if value < 0 else ""
    value = abs(value)

    # repr() yields the shortest decimal string that round-trips to the same
    # double, i.e. the same digit sequence ECMAScript uses.
    text = repr(value)
    if "e" in text or "E" in text:
        mantissa, exponent_text = text.lower().split("e")
        exponent = int(exponent_text)
    else:
        mantissa, exponent = text, 0

    integer_part, _, fraction_part = mantissa.partition(".")
    joined = integer_part + fraction_part
    digits = joined.lstrip("0")
    leading_zeros = len(joined) - len(digits)
    if not digits:
        return "0"
    digits = digits.rstrip("0")

    # Decimal exponent of the first significant digit:
    # value == d[0].d[1:] * 10**exponent_of_first.
    decimal_exponent = len(integer_part) - 1 + exponent - leading_zeros
    digit_count = len(digits)

    # ECMAScript uses fixed notation for exponents in [-6, 21).
    if -6 <= decimal_exponent < 21:
        if decimal_exponent >= digit_count - 1:
            body = digits + "0" * (decimal_exponent - digit_count + 1)
        elif decimal_exponent >= 0:
            body = digits[: decimal_exponent + 1] + "." + digits[decimal_exponent + 1 :]
        else:
            body = "0." + "0" * (-decimal_exponent - 1) + digits
    else:
        body = digits[0]
        if digit_count > 1:
            body += "." + digits[1:]
        body += "e" + ("+" if decimal_exponent >= 0 else "-")
        body += str(abs(decimal_exponent))

    return sign + body
