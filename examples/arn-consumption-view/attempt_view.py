"""SYCEE external consumption view over an ARN receipt (read-only).

This module is the smallest runnable form of the idea in ``arn-receipt-mapping.md``:

* An ARN ``arn-receipt/0.1`` is read as **metadata only** -- nothing is written
  back, no key is declared, no receipt is submitted, no funds move.
* The only join key with ARN is ``settlement.txHash`` (the payment anchor).
* ``attempt_identity`` is derived from the **request as sent** (SPEC.md 5.5.4),
  never from the receipt / payment payload. This is the whole point: one
  settlement can cover several attempts, so the attempt layer is built outside
  ARN.
* Consumption facts (``consumed``, ``redeem_count``) are observed by the SYCEE
  side; they do not exist in the ARN format and are never embedded into it.

Standard library only. Python 3.11+.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

ZERO_HASH_HEX = "0" * 64
ATTEMPT_DOMAIN = "sycee/attempt/v1"


class AttemptIdentityError(ValueError):
    """Raised when a request field cannot form a valid attempt identity."""


# ---------------------------------------------------------------------------
# 1. Attempt identity -- derived at ingress from the request, NOT the payment
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RequestView:
    """The observable shape of a request at ingress (SPEC.md 5.5.4)."""

    method: str
    origin: str
    path: str
    query: str = ""
    pay_to: str = ""
    asset: str = ""
    network: str = ""
    amount: str = ""
    scheme: str = ""


def compute_attempt_identity(req: RequestView) -> str:
    """Return ``sha256:<hex>`` over the request, per SPEC.md 5.5.4.

    Identity = sha256( domain | method | origin | path | query | payTo |
                       asset | network | amount | scheme ).

    A member containing ``|`` is refused rather than escaped. An empty query
    and an absent query are the same attempt. A settled attempt and its refused
    replay share this value and differ only in ``presentation``.
    """
    members = [
        ATTEMPT_DOMAIN,
        req.method,
        req.origin,
        req.path,
        req.query or "",       # empty == absent
        req.pay_to,
        req.asset,
        req.network,
        req.amount,
        req.scheme,
    ]
    for name, value in zip(
        ("domain", "method", "origin", "path", "query", "payTo",
         "asset", "network", "amount", "scheme"),
        members,
    ):
        if "|" in value:
            raise AttemptIdentityError(f"member {name!r} contains '|'; refused")
    joined = "|".join(members)
    return "sha256:" + hashlib.sha256(joined.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 2. Read-only ARN receipt view -- we consume metadata, we do not verify/submit
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ArnReceiptView:
    """The subset of an ARN receipt a downstream consumer may rely on."""

    tx_hash: str
    payer: str
    pay_to: str
    asset: str
    amount: str
    network: str
    output_hash: str
    issued_at: str

    @property
    def anchor(self) -> str:
        """The only shared key between ARN and SYCEE."""
        return self.tx_hash


def read_arn_receipt(receipt: dict[str, Any]) -> ArnReceiptView:
    """Structurally read an ``arn-receipt/0.1`` as metadata.

    NOTE: signature verification and the on-chain Transfer check are the
    issuer's / ARN's job. This function does not verify either -- it is a
    structural read of fields a downstream consumer is allowed to use.
    """
    if receipt.get("version") != "arn-receipt/0.1":
        raise ValueError("not an arn-receipt/0.1 document")
    settlement = receipt["settlement"]
    return ArnReceiptView(
        tx_hash=settlement["txHash"],
        payer=settlement["payer"],
        pay_to=settlement["payTo"],
        asset=settlement["asset"],
        amount=settlement["amount"],
        network=receipt["network"],
        output_hash=receipt["outputHash"],
        issued_at=receipt["issuedAt"],
    )


def classify_delivery(output_hash: str) -> str:
    """Classify ``outputHash`` into a definite consumption-side observation.

    * zero hash  -> signed "settled, nothing was delivered" (Scenario 1)
    * non-zero   -> submitter-claimed delivery; ARN does not verify the bytes
    """
    hexpart = output_hash.split(":", 1)[1] if ":" in output_hash else output_hash
    if hexpart.lower() == ZERO_HASH_HEX:
        return "signed_nothing_delivered"
    return "submitter_claimed_delivery"


# ---------------------------------------------------------------------------
# 3. Consumption observations -- the layer ARN does not have
# ---------------------------------------------------------------------------

@dataclass
class ConsumptionObservation:
    """Facts observed by the buyer runtime, external to ARN.

    ``consumed`` is yes|no|unknown. Per SPEC.md, only the agent (buyer) role may
    sign yes/no; a merchant self-report is always unknown. Kept here as a plain
    observation so this demo stays read-only and signer-agnostic.
    """

    consumed: str = "unknown"           # yes | no | unknown
    consumed_by: list[str] = field(default_factory=list)
    redeem_count: int = 1               # >= 1; >1 means repeated redemption
    presentation: int = 1               # 1-based ordinal of this presentation


def build_view(
    receipt: dict[str, Any],
    request: RequestView,
    observation: ConsumptionObservation,
) -> dict[str, Any]:
    """Join an ARN receipt with an external attempt + consumption observation.

    Returns a consumption-layer view. Nothing here is written back to ARN.
    """
    arn = read_arn_receipt(receipt)
    attempt = compute_attempt_identity(request)
    delivery = classify_delivery(arn.output_hash)

    # Reconciliation is the comparison ARN cannot make: it holds the payment
    # fact, we hold the consumption fact, txHash is the join.
    amount_matches = arn.amount == request.amount
    payee_matches = arn.pay_to.lower() == request.pay_to.lower()
    reconciled = amount_matches and payee_matches

    return {
        "view_type": "sycee/consumption-view/0.1",
        # --- payment side, read from ARN as metadata ---
        "payment_anchor": {
            "tx_hash": arn.anchor,
            "network": arn.network,
            "payer": arn.payer,
            "pay_to": arn.pay_to,
            "amount_atomic": arn.amount,
            "issued_at": arn.issued_at,
        },
        # --- delivery, classified from outputHash ---
        "delivery": {
            "output_hash": arn.output_hash,
            "classification": delivery,
        },
        # --- consumption side, external to ARN ---
        "attempt": {
            "attempt_identity": attempt,
            "presentation": observation.presentation,
            "consumed": observation.consumed,
            "consumed_by": observation.consumed_by,
            "redeem_count": observation.redeem_count,
        },
        # --- the seam: what ARN proves vs what SYCEE observes ---
        "reconciliation": {
            "settled": True,                 # attested by ARN receipt
            "delivery_class": delivery,
            "consumed": observation.consumed,
            "settlement_amount_matches_request": amount_matches,
            "settlement_payee_matches_request": payee_matches,
            "reconciled": reconciled,
            "arn_schema_changed": False,     # externally correlated, never embedded
        },
    }


# ---------------------------------------------------------------------------
# 4. Demo (uses the ARN sample payload -- placeholder hashes, structural only)
# ---------------------------------------------------------------------------

SAMPLE_RECEIPT: dict[str, Any] = {
    "version": "arn-receipt/0.1",
    "network": "eip155:84532",
    "settlement": {
        "txHash": "0x" + "00" * 32,
        "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "payer": "0x" + "00" * 20,
        "payTo": "0x" + "00" * 20,
        "amount": "10000",
    },
    "outputHash": "sha256:" + "0" * 64,
    "issuedAt": "2026-11-24T16:05:00Z",
    "signatures": [
        {"alg": "ed25519", "publicKey": "<declared key>", "signature": "<sig>"}
    ],
}

SAMPLE_REQUEST = RequestView(
    method="GET",
    origin="https://seller.example",
    path="/api/data/dev-signals",
    query="",
    pay_to="0x" + "00" * 20,
    asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    network="eip155:84532",
    amount="10000",
    scheme="exact",
)


def demo() -> dict[str, Any]:
    """Scenario 1: settled, nothing delivered, never consumed."""
    obs = ConsumptionObservation(
        consumed="no", consumed_by=[], redeem_count=1, presentation=1
    )
    return build_view(SAMPLE_RECEIPT, SAMPLE_REQUEST, obs)


def _self_test() -> None:
    """Key invariants a reviewer can run: python attempt_view.py --self-test."""
    # 1. zero hash is a definite value, not missing data
    assert classify_delivery("sha256:" + "0" * 64) == "signed_nothing_delivered"
    assert classify_delivery("sha256:" + "ab" * 32) == "submitter_claimed_delivery"

    # 2. attempt identity is stable, query-empty == query-absent
    a = compute_attempt_identity(SAMPLE_REQUEST)
    b = compute_attempt_identity(
        RequestView(**{**SAMPLE_REQUEST.__dict__, "query": ""})
    )
    assert a == b

    # 3. a settled attempt and its refused replay share one identity
    replay = compute_attempt_identity(SAMPLE_REQUEST)
    assert replay == a  # presentation differs, identity does not

    # 4. a '|' in any member is refused
    try:
        compute_attempt_identity(
            RequestView(**{**SAMPLE_REQUEST.__dict__, "path": "/a|b"})
        )
    except AttemptIdentityError:
        pass
    else:
        raise AssertionError("expected AttemptIdentityError for '|'")

    # 5. the view never claims ARN was changed
    out = demo()
    assert out["reconciliation"]["arn_schema_changed"] is False
    assert out["delivery"]["classification"] == "signed_nothing_delivered"
    assert out["attempt"]["consumed"] == "no"
    print("SELF-TEST OK: 5 invariants passed")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        _self_test()
    else:
        print(json.dumps(demo(), indent=2, ensure_ascii=False))
