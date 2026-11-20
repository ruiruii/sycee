"""Offline verification of a SYCEE VSR envelope.

The rules here come from SPEC.md, not from the reference JavaScript:

* §6.1   field requirements (schema_version, proof_hash, consumed,
         redeem_count, settlement_status, signer.role, signature).
* §6.1.1 settlement/delivery cross-checks.
* §5.3   consumption is signed by the agent side, never self-reported by the
         merchant: ``role = merchant`` may only carry ``consumed = unknown``
         unless the result block is bilaterally co-signed (§10 L2).
* §5.6   ``completeness`` claims which sides signed.
* §6     no request body, response body, or raw payment proof may appear.
* §7.3   re-canonicalize, verify Ed25519, check schema_version and consumed.

Conformance levels follow §10: L0 unsigned telemetry, L1 one signer, and L2 only
for a verified pair — never for a single envelope, whatever it claims. ``invalid``
means at least one semantic rule failed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from . import signing
from .canonical import CanonicalizationError, canonical_bytes

SCHEMA_VERSION = "sycee/v0.1"

PROTOCOLS = frozenset(
    {"x402", "mpp", "ap2", "alipay-a2m", "apop", "a2p2", "card-a2a", "other"}
)
DELIVERY_STATUS = frozenset({"delivered", "partial", "failed", "timeout"})
CONSUMED_VALUES = frozenset({"yes", "no", "unknown"})
ROLES = frozenset({"merchant", "agent", "observer"})
SETTLEMENT_STATUS = frozenset({"settled", "in_flight", "absent"})
COMPLETENESS_VALUES = frozenset(
    {"bilateral", "unilateral_merchant", "unilateral_agent", "unknown"}
)

HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
PUBLIC_KEY_RE = re.compile(r"^ed25519:[A-Za-z0-9_-]+$")
SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_-]+$")
DECIMAL_RE = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")

_ENVELOPE_KEYS = frozenset({"vsr", "signature"})
_VSR_KEYS = frozenset(
    {
        "schema_version",
        "protocol",
        "resource_id",
        "request_fingerprint",
        "payment",
        "amount",
        "delivery",
        "result",
        "signer",
        "completeness",
        "_vendor",
    }
)
_PAYMENT_KEYS = frozenset(
    {
        "proof_hash",
        "redeem_count",
        "redeem_resources",
        "settlement_status",
        "proof_seen_at",
        "complete_seen_at",
        "trade_no",
    }
)
_AMOUNT_KEYS = frozenset({"value", "currency"})
_DELIVERY_KEYS = frozenset({"status", "delivered_at", "bytes"})
_RESULT_KEYS = frozenset(
    {"consumed", "consumed_by", "consumed_at", "freshness_s"}
)
_SIGNER_KEYS = frozenset({"agent_id", "public_key", "key_id", "role"})

# Keys that name a raw credential rather than its hash. §6 forbids the proof
# body anywhere in the envelope; `proof_hash` and `*_seen_at` are not matched.
_FORBIDDEN_KEY_TOKENS = (
    "payment_proof",
    "payment-proof",
    "raw_proof",
    "proof_body",
    "payment_signature",
    "payment-signature",
    "x_payment",
    "x-payment",
)
# Recognisable credential carriers inside string values.
_FORBIDDEN_VALUE_MARKERS = ("PAYMENT-SIGNATURE", "X-PAYMENT")


@dataclass(frozen=True)
class Issue:
    """A single failed rule, tagged with a stable machine-readable code."""

    code: str
    path: str
    message: str

    def __str__(self) -> str:
        return f"{self.path}: {self.message}"


@dataclass
class Report:
    level: str
    schema_valid: bool
    signature_valid: bool
    settlement: str
    errors: list[Issue] = field(default_factory=list)
    schema_errors: list[Issue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        """No semantic rule failed (mirrors "coherent and correctly signed")."""
        return not self.errors

    @property
    def accepted(self) -> bool:
        """A verifiable receipt: schema-valid, signed, L1 or L2."""
        return (
            self.valid
            and self.schema_valid
            and self.signature_valid
            and self.level in ("L1", "L2")
        )

    @property
    def all_issues(self) -> list[Issue]:
        return [*self.schema_errors, *self.errors]

    def error_codes(self) -> set[str]:
        return {issue.code for issue in self.all_issues}


def verify_envelope(
    envelope: Any,
    *,
    require_settled: bool = False,
    allow_unpaid_delivery: bool = False,
) -> Report:
    """Verify one ``{ "vsr": ..., "signature": ... }`` envelope offline."""
    schema_errors = _check_schema(envelope)

    if not isinstance(envelope, dict):
        return Report(
            level="invalid",
            schema_valid=False,
            signature_valid=False,
            settlement="unknown",
            errors=[Issue("invalid_envelope", "$", "envelope must be a JSON object")],
            schema_errors=schema_errors,
        )

    vsr = envelope.get("vsr")
    if not isinstance(vsr, dict):
        return Report(
            level="invalid",
            schema_valid=False,
            signature_valid=False,
            settlement="unknown",
            errors=[Issue("invalid_vsr", "vsr", "must be an object")],
            schema_errors=schema_errors,
        )

    errors, warnings, consistency = _check_semantics(
        vsr,
        require_settled=require_settled,
        allow_unpaid_delivery=allow_unpaid_delivery,
    )

    signature = envelope.get("signature")
    signed = isinstance(signature, str) and bool(signature)
    signature_valid = _verify_signature(vsr, signature, errors) if signed else False
    if not signed:
        warnings.append("signature: absent — L0 telemetry only, not a verifiable receipt")

    # §10: L2 is a verdict about a pair, not a property of one envelope. A lone
    # envelope that claims `bilateral` is capped here, with a warning that names
    # the claim — the counterpart may not exist, may be unsigned, or may describe
    # a different attempt.
    if vsr.get("completeness") == "bilateral":
        warnings.append(
            "completeness = bilateral: a claim about a pair, not a property of one envelope; "
            "pair it with the other side to reach L2"
        )

    if errors:
        level = "invalid"
    elif not signed:
        level = "L0"
    else:
        level = "L1"

    return Report(
        level=level,
        schema_valid=not schema_errors,
        signature_valid=signature_valid,
        settlement=consistency,
        errors=errors,
        schema_errors=schema_errors,
        warnings=warnings,
    )


# --------------------------------------------------------------------------
# Schema checks (the structural half of §6.1)
# --------------------------------------------------------------------------


def _check_schema(envelope: Any) -> list[Issue]:
    issues: list[Issue] = []
    if not isinstance(envelope, dict):
        return [Issue("schema_violation", "$", "envelope must be a JSON object")]

    _check_keys(issues, envelope, "$", _ENVELOPE_KEYS, required=("vsr", "signature"))

    vsr = envelope.get("vsr")
    if not isinstance(vsr, dict):
        if "vsr" in envelope:
            issues.append(Issue("schema_violation", "$.vsr", "must be an object"))
        return issues

    _check_keys(
        issues,
        vsr,
        "$.vsr",
        _VSR_KEYS,
        required=(
            "schema_version",
            "protocol",
            "resource_id",
            "payment",
            "delivery",
            "result",
            "signer",
        ),
    )

    if vsr.get("schema_version") != SCHEMA_VERSION:
        issues.append(
            Issue(
                "schema_violation",
                "$.vsr.schema_version",
                f"must be {SCHEMA_VERSION!r}",
            )
        )
    if vsr.get("protocol") not in PROTOCOLS:
        issues.append(
            Issue("schema_violation", "$.vsr.protocol", "unregistered protocol value")
        )
    _check_nonempty_string(issues, vsr, "resource_id", "$.vsr.resource_id")
    if "request_fingerprint" in vsr:
        _check_pattern(issues, vsr["request_fingerprint"], HASH_RE, "$.vsr.request_fingerprint", "sha256:<64 hex>")
    if "completeness" in vsr and vsr["completeness"] not in COMPLETENESS_VALUES:
        issues.append(Issue("schema_violation", "$.vsr.completeness", "unknown completeness value"))
    if "_vendor" in vsr and not isinstance(vsr["_vendor"], dict):
        issues.append(Issue("schema_violation", "$.vsr._vendor", "must be an object"))

    _check_payment_schema(issues, vsr.get("payment"))
    _check_amount_schema(issues, vsr.get("amount"))
    _check_delivery_schema(issues, vsr.get("delivery"))
    _check_result_schema(issues, vsr.get("result"))
    _check_signer_schema(issues, vsr.get("signer"))

    signature = envelope.get("signature")
    if "signature" in envelope:
        if not isinstance(signature, str) or not SIGNATURE_RE.match(signature):
            issues.append(
                Issue(
                    "schema_violation",
                    "$.signature",
                    "must be a base64url string without padding",
                )
            )
    return issues


def _check_payment_schema(issues: list[Issue], payment: Any) -> None:
    if not isinstance(payment, dict):
        if payment is not None:
            issues.append(Issue("schema_violation", "$.vsr.payment", "must be an object"))
        return
    _check_keys(
        issues,
        payment,
        "$.vsr.payment",
        _PAYMENT_KEYS,
        required=("proof_hash", "redeem_count"),
    )
    _check_pattern(issues, payment.get("proof_hash"), HASH_RE, "$.vsr.payment.proof_hash", "sha256:<64 hex>")
    _check_integer(issues, payment.get("redeem_count"), "$.vsr.payment.redeem_count", minimum=1)
    if "settlement_status" in payment and payment["settlement_status"] not in SETTLEMENT_STATUS:
        issues.append(
            Issue(
                "schema_violation",
                "$.vsr.payment.settlement_status",
                "must be settled | in_flight | absent",
            )
        )
    if "redeem_resources" in payment:
        _check_string_array(issues, payment["redeem_resources"], "$.vsr.payment.redeem_resources")
    for name in ("proof_seen_at", "complete_seen_at"):
        if name in payment:
            _check_pattern(issues, payment[name], TIMESTAMP_RE, f"$.vsr.payment.{name}", "ISO 8601 UTC with milliseconds")
    if "trade_no" in payment and not isinstance(payment["trade_no"], str):
        issues.append(Issue("schema_violation", "$.vsr.payment.trade_no", "must be a string"))


def _check_amount_schema(issues: list[Issue], amount: Any) -> None:
    if amount is None:
        return
    if not isinstance(amount, dict):
        issues.append(Issue("schema_violation", "$.vsr.amount", "must be an object"))
        return
    _check_keys(issues, amount, "$.vsr.amount", _AMOUNT_KEYS)
    if "value" in amount:
        _check_pattern(issues, amount["value"], DECIMAL_RE, "$.vsr.amount.value", "decimal string")
    if "currency" in amount and not isinstance(amount["currency"], str):
        issues.append(Issue("schema_violation", "$.vsr.amount.currency", "must be a string"))


def _check_delivery_schema(issues: list[Issue], delivery: Any) -> None:
    if not isinstance(delivery, dict):
        if delivery is not None:
            issues.append(Issue("schema_violation", "$.vsr.delivery", "must be an object"))
        return
    _check_keys(issues, delivery, "$.vsr.delivery", _DELIVERY_KEYS, required=("status",))
    if "status" in delivery and delivery["status"] not in DELIVERY_STATUS:
        issues.append(
            Issue(
                "schema_violation",
                "$.vsr.delivery.status",
                "must be delivered | partial | failed | timeout",
            )
        )
    if "delivered_at" in delivery:
        _check_pattern(issues, delivery["delivered_at"], TIMESTAMP_RE, "$.vsr.delivery.delivered_at", "ISO 8601 UTC with milliseconds")
    if "bytes" in delivery:
        _check_integer(issues, delivery["bytes"], "$.vsr.delivery.bytes", minimum=0)


def _check_result_schema(issues: list[Issue], result: Any) -> None:
    if not isinstance(result, dict):
        if result is not None:
            issues.append(Issue("schema_violation", "$.vsr.result", "must be an object"))
        return
    _check_keys(issues, result, "$.vsr.result", _RESULT_KEYS, required=("consumed",))
    if "consumed" in result and result["consumed"] not in CONSUMED_VALUES:
        issues.append(
            Issue("schema_violation", "$.vsr.result.consumed", "must be yes | no | unknown")
        )
    if "consumed_by" in result:
        _check_string_array(issues, result["consumed_by"], "$.vsr.result.consumed_by")
    if "consumed_at" in result:
        _check_pattern(issues, result["consumed_at"], TIMESTAMP_RE, "$.vsr.result.consumed_at", "ISO 8601 UTC with milliseconds")
    if "freshness_s" in result:
        _check_integer(issues, result["freshness_s"], "$.vsr.result.freshness_s", minimum=0)


def _check_signer_schema(issues: list[Issue], signer: Any) -> None:
    if not isinstance(signer, dict):
        if signer is not None:
            issues.append(Issue("schema_violation", "$.vsr.signer", "must be an object"))
        return
    _check_keys(issues, signer, "$.vsr.signer", _SIGNER_KEYS, required=("public_key", "role"))
    _check_pattern(issues, signer.get("public_key"), PUBLIC_KEY_RE, "$.vsr.signer.public_key", "ed25519:<base64url>")
    if "role" in signer and signer["role"] not in ROLES:
        issues.append(Issue("schema_violation", "$.vsr.signer.role", "must be merchant | agent | observer"))
    for name in ("agent_id", "key_id"):
        if name in signer and not isinstance(signer[name], str):
            issues.append(Issue("schema_violation", f"$.vsr.signer.{name}", "must be a string"))


def _check_keys(
    issues: list[Issue],
    value: dict,
    path: str,
    allowed: frozenset[str],
    required: tuple[str, ...] = (),
) -> None:
    for name in required:
        if name not in value:
            issues.append(Issue("missing_required", f"{path}.{name}", "required but missing"))
    for name in value:
        if name not in allowed:
            issues.append(Issue("schema_violation", f"{path}.{name}", "additional property not allowed"))


def _check_nonempty_string(issues: list[Issue], parent: dict, name: str, path: str) -> None:
    value = parent.get(name)
    if not isinstance(value, str) or not value:
        issues.append(Issue("schema_violation", path, "must be a non-empty string"))


def _check_pattern(issues: list[Issue], value: Any, regex: re.Pattern[str], path: str, expected: str) -> None:
    if not isinstance(value, str) or not regex.match(value):
        issues.append(Issue("schema_violation", path, f"must match {expected}"))


def _check_integer(issues: list[Issue], value: Any, path: str, *, minimum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        issues.append(Issue("schema_violation", path, "must be an integer"))
    elif value < minimum:
        issues.append(Issue("schema_violation", path, f"must be >= {minimum}"))


def _check_string_array(issues: list[Issue], value: Any, path: str) -> None:
    if not isinstance(value, list):
        issues.append(Issue("schema_violation", path, "must be an array of strings"))
        return
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item:
            issues.append(Issue("schema_violation", f"{path}[{index}]", "must be a non-empty string"))


# --------------------------------------------------------------------------
# Semantic checks (§5.3, §5.6, §6, §6.1.1)
# --------------------------------------------------------------------------


def _check_semantics(
    vsr: dict,
    *,
    require_settled: bool,
    allow_unpaid_delivery: bool,
) -> tuple[list[Issue], list[str], str]:
    errors: list[Issue] = []
    warnings: list[str] = []

    if vsr.get("schema_version") != SCHEMA_VERSION:
        errors.append(Issue("unsupported_schema_version", "schema_version", f"expected {SCHEMA_VERSION}"))
    if vsr.get("protocol") not in PROTOCOLS:
        warnings.append(f"protocol: unregistered value {vsr.get('protocol')!r}")
    resource_id = vsr.get("resource_id")
    if not isinstance(resource_id, str) or not resource_id:
        errors.append(Issue("invalid_resource_id", "resource_id", "required non-empty string"))

    payment = vsr.get("payment") if isinstance(vsr.get("payment"), dict) else {}
    proof_hash = payment.get("proof_hash")
    if not isinstance(proof_hash, str) or not HASH_RE.match(proof_hash):
        errors.append(Issue("invalid_proof_hash", "payment.proof_hash", "required, must be sha256:<64 hex>"))
    redeem_count = payment.get("redeem_count")
    if isinstance(redeem_count, bool) or not isinstance(redeem_count, int) or redeem_count < 1:
        errors.append(Issue("invalid_redeem_count", "payment.redeem_count", "required integer >= 1"))
    elif redeem_count > 1:
        warnings.append(f"payment.redeem_count = {redeem_count}: one proof was redeemed more than once")

    settlement_status = payment.get("settlement_status", "in_flight")
    if settlement_status not in SETTLEMENT_STATUS:
        errors.append(Issue("invalid_settlement_status", "payment.settlement_status", "must be settled | in_flight | absent"))

    delivery = vsr.get("delivery") if isinstance(vsr.get("delivery"), dict) else {}
    delivery_status = delivery.get("status")
    if delivery_status not in DELIVERY_STATUS:
        errors.append(Issue("invalid_delivery_status", "delivery.status", "must be delivered | partial | failed | timeout"))

    # §6.1.1: evaluate the pair, not either field alone.
    if settlement_status in SETTLEMENT_STATUS and delivery_status in DELIVERY_STATUS:
        consistency = settlement_consistency(delivery_status, settlement_status)
        if consistency == "contradiction":
            message = (
                "settlement_status = absent with delivery.status = delivered: bytes claimed "
                "for a payment that has no transaction"
            )
            if allow_unpaid_delivery:
                warnings.append(message)
            else:
                errors.append(Issue("settlement_contradiction", "payment.settlement_status", message))
        elif consistency == "incomplete":
            warnings.append("payment.settlement_status = in_flight: unproven, not refuted")
        elif delivery_status in ("failed", "timeout"):
            warnings.append(f"settled but delivery.status = {delivery_status}: paid without fulfilment")
    else:
        consistency = "unknown"

    if require_settled and settlement_status != "settled":
        errors.append(Issue("not_settled", "payment.settlement_status", "requireSettled is set and the payment is not confirmed"))

    result = vsr.get("result") if isinstance(vsr.get("result"), dict) else {}
    consumed = result.get("consumed")
    if consumed not in CONSUMED_VALUES:
        errors.append(Issue("invalid_consumed", "result.consumed", "must be yes | no | unknown"))
    elif consumed == "unknown":
        warnings.append("result.consumed = unknown: downstream context was not instrumented")
    elif consumed == "yes" and not isinstance(result.get("consumed_by"), list):
        warnings.append("result.consumed = yes without consumed_by evidence: assertion, not attestation")
    elif consumed == "no":
        warnings.append("result.consumed = no: delivered but never referenced — idle spend")

    signer = vsr.get("signer") if isinstance(vsr.get("signer"), dict) else {}
    public_key = signer.get("public_key")
    if not isinstance(public_key, str) or not PUBLIC_KEY_RE.match(public_key):
        errors.append(Issue("invalid_public_key", "signer.public_key", "required, format ed25519:<base64url>"))
    role = signer.get("role")
    if role not in ROLES:
        errors.append(Issue("invalid_role", "signer.role", "must be merchant | agent | observer"))

    # §5.3: `consumed` is not a merchant self-report. A merchant may only sign
    # yes/no when the result block is bilaterally co-signed (§10 L2).
    completeness = vsr.get("completeness")
    if completeness is not None and completeness not in COMPLETENESS_VALUES:
        errors.append(Issue("invalid_completeness", "completeness", "unknown completeness value"))
    if consumed in ("yes", "no") and role == "merchant" and completeness != "bilateral":
        errors.append(
            Issue(
                "role_conflict",
                "result.consumed",
                f"merchant-signed consumed = {consumed!r} requires a bilateral co-signed "
                "result block (§5.3)",
            )
        )
    if completeness == "unilateral_merchant" and role not in (None, "merchant"):
        errors.append(Issue("completeness_conflict", "completeness", f"claims unilateral_merchant but signer.role = {role!r}"))
    if completeness == "unilateral_agent" and role not in (None, "agent"):
        errors.append(Issue("completeness_conflict", "completeness", f"claims unilateral_agent but signer.role = {role!r}"))
    if completeness == "bilateral" and consumed in ("yes", "no") and role == "merchant":
        warnings.append(
            "completeness = bilateral is asserted by a single signature; the co-signed result "
            "block is not independently verifiable from this envelope"
        )

    # §6: the raw payment proof must never appear anywhere in the envelope.
    for path, name, value in _walk(vsr, "$.vsr"):
        lowered = name.lower()
        if any(token in lowered for token in _FORBIDDEN_KEY_TOKENS):
            errors.append(Issue("embedded_payment_proof", path, f"raw credential field {name!r} is forbidden (§6)"))
        elif isinstance(value, str) and any(marker in value.upper() for marker in _FORBIDDEN_VALUE_MARKERS):
            errors.append(Issue("embedded_payment_proof", path, "value looks like a raw payment credential (§6)"))

    return errors, warnings, consistency


def settlement_consistency(delivery_status: str, settlement_status: str) -> str:
    """Classify the (§6.1.1) pair: ok | incomplete | contradiction."""
    if settlement_status == "absent" and delivery_status == "delivered":
        return "contradiction"
    if settlement_status != "settled":
        return "incomplete"
    return "ok"


def _walk(value: Any, path: str):
    if isinstance(value, dict):
        for key, item in value.items():
            child = f"{path}.{key}"
            yield child, key, item
            yield from _walk(item, child)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            child = f"{path}[{index}]"
            yield from _walk(item, child)


def _verify_signature(vsr: dict, signature: str, errors: list[Issue]) -> bool:
    signer = vsr.get("signer") if isinstance(vsr.get("signer"), dict) else {}
    public_key = signer.get("public_key")
    if not isinstance(public_key, str) or not PUBLIC_KEY_RE.match(public_key):
        return False
    try:
        # SPEC.md §7.3: canonical bytes of the `vsr` object, nothing else.
        ok = signing.verify(public_key, canonical_bytes(vsr), signature)
        if not ok:
            errors.append(Issue("signature_invalid", "signature", "Ed25519 verification failed"))
        return ok
    except (signing.SignatureError, CanonicalizationError) as exc:
        errors.append(Issue("signature_invalid", "signature", str(exc)))
        return False
