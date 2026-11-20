#!/usr/bin/env python3
"""An independent known-answer checker for the section 15 refusal-row vectors.

Written from the text of specs/extensions/refusal-row.md — section 5 for the
closed reason set and its ceilings, section 15 for the leg observations, the
split-leg reason, and the reproducibility rule. Standard library only: nothing
here imports the JavaScript implementation, on purpose. If the two disagree, the
disagreement is the finding.

Usage:
    python3 verify_known_answers.py [dir] [--json]

Exit 0 when every file was read. Exit 2 when the checker itself could not run.
"""

import json
import pathlib
import sys

# §5 lists the closed reason set with a ceiling per reason. Written out here as a
# table rather than derived, because a derived table cannot be audited against
# the prose.
CEILING = {
    "invalid_signature": "client_verifiable",
    "wrong_amount": "client_verifiable",
    "wrong_recipient": "client_verifiable",
    "malformed_payload": "client_verifiable",
    "authorization_expired": "chain_verifiable",
    "authorization_not_yet_valid": "chain_verifiable",
    # §5: the balance is a value at a block and the row carries no block
    # reference, so a third party can check a similar balance later, never
    # this one. The table records what a row may claim, not what the reason
    # could reach if the format were different.
    "insufficient_funds": "issuer_asserted",
    "duplicate_payment": "chain_verifiable",
    "nonce_already_used": "chain_verifiable",
    "transfer_leg_failed": "chain_verifiable",
    "facilitator_timeout": "issuer_asserted",
    "risk_policy_rejected": "issuer_asserted",
    "commercial_refusal": "issuer_asserted",
    "internal_error": "issuer_asserted",
}

# Reasons that are refused but are not in the ceiling table's closed set above
# still need a name; §5 keeps one list, so these live in it as well.
OTHER_REASONS = {
    "replay_already_settled": "chain_verifiable",
    "replay_in_flight": "issuer_asserted",
    "could_not_compare": "issuer_asserted",
}
CEILING.update(OTHER_REASONS)

ORDER = ["issuer_asserted", "client_verifiable", "chain_verifiable", "independently_witnessed"]

# §15.4, L2: a reason that makes a causal claim about a leg must record that leg,
# and the recorded status must be one the reason permits. A reason that makes no
# claim about a leg must not carry a contradicting observation either.
LEG_CONTRACT = {
    "invalid_signature": {"authorization": ("failed", "unknown")},
    "wrong_amount": {"authorization": ("failed", "unknown")},
    "wrong_recipient": {"authorization": ("failed", "unknown")},
    "malformed_payload": {"authorization": ("failed", "unknown", "not_reached")},
    "authorization_expired": {"authorization": ("failed", "unknown")},
    "authorization_not_yet_valid": {"authorization": ("failed", "unknown")},
    "insufficient_funds": {"authorization": ("failed", "unknown")},
    "nonce_already_used": {"authorization": ("failed", "executed")},
    # §5 defines the reason as a conjunction: the authorization leg executed and
    # the transfer leg did not. Both halves are pinned, so `unknown` on either leg
    # is out — a merchant who saw neither conclusion records facilitator_timeout
    # or internal_error instead (§15.3).
    "transfer_leg_failed": {"authorization": ("executed",), "transfer": ("failed",)},
    "facilitator_timeout": {"authorization": ("unknown",)},
    "internal_error": {"authorization": ("executed", "unknown")},
    "risk_policy_rejected": {"authorization": ("not_reached", "unknown")},
    "commercial_refusal": {"authorization": ("not_reached", "unknown")},
    "replay_already_settled": {"authorization": ("executed",)},
}

LEGS = ("authorization", "transfer")
LEG_STATUS = ("not_reached", "executed", "failed", "unknown")
SETTLEMENT_STATES = ("not_submitted", "pending", "settled", "unknown")

# §15.5: the legs a reason's truth depends on having *run*. A reason whose causal
# claim rests on the transfer leg can never exceed issuer_asserted, because a
# balance movement is per-account and the ledger carries no attempt identity.
DEPENDS_ON_EXECUTED = {
    "transfer_leg_failed": ("authorization", "transfer"),
}
UNATTRIBUTABLE = ("transfer",)


class Refused(Exception):
    """A row must not be constructible from this input."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def reproducible_ceiling(reason, claimed):
    """§15.5: may this reason claim this class at all?"""
    depends = DEPENDS_ON_EXECUTED.get(reason, ())
    if any(leg in UNATTRIBUTABLE for leg in depends):
        # The causal claim rests on a positive marker no third party can tie to
        # one attempt, so the honest class is the issuer's word.
        if ORDER.index(claimed) > ORDER.index("issuer_asserted"):
            raise Refused("not_reproducible")
        return "issuer_asserted"
    base = CEILING.get(reason)
    if base is None:
        raise Refused("unreviewed_reason")
    if ORDER.index(claimed) > ORDER.index(base):
        raise Refused("exceeds_ceiling")
    return claimed


def check_legs(legs, reason):
    """§15.4 L1-L3. Returns the status of the contract check, not the row."""
    if legs is None:
        # L1: omitting legs asserts nothing about either leg.
        return
    if not isinstance(legs, dict):
        raise Refused("unknown_leg")
    for leg, status in legs.items():
        # L3: an unknown leg name or status is a malformed row, rejected rather
        # than ignored — a reader cannot tell an ignored field from an unwritten one.
        if leg not in LEGS:
            raise Refused("unknown_leg")
        if status not in LEG_STATUS:
            raise Refused("unknown_leg_status")
    contract = LEG_CONTRACT.get(reason)
    if contract is None:
        raise Refused("no_leg_contract")
    for leg, allowed in contract.items():
        observed = legs.get(leg)
        if observed is None:
            raise Refused("leg_not_observed")
        if observed not in allowed:
            raise Refused("leg_contradicts_reason")


def build(vec_input):
    """The constructor, written from §15. Returns the three fields the vectors name."""
    decision = vec_input["decision"]
    settlement = vec_input.get("settlement", "not_submitted")
    final = vec_input.get("final", settlement != "pending")

    if decision not in ("accepted", "refused"):
        raise Refused("bad_decision")
    if settlement not in SETTLEMENT_STATES:
        raise Refused("bad_settlement")
    if settlement == "pending" and final:
        raise Refused("finality_pending_is_not_final")
    # `accepted` + `not_submitted` is legal: §13 lists it as the output for a
    # purchase_not_settled loser, and the reference constructor produces it for a
    # first presentation. An earlier version of this reader refused the pair; the
    # text does not, so neither does this.

    evidence = None
    if decision == "refused":
        reason = vec_input.get("reason")
        if reason not in CEILING:
            raise Refused("unreviewed_reason")
        check_legs(vec_input.get("legs"), reason)
        claim = vec_input.get("evidence_class")
        if claim is None:
            # §15.7: the default is the reproducible ceiling, not the reason's
            # base ceiling. Claiming by omission is claiming.
            base = CEILING[reason]
            depends = DEPENDS_ON_EXECUTED.get(reason, ())
            claim = "issuer_asserted" if any(l in UNATTRIBUTABLE for l in depends) else base
        evidence = reproducible_ceiling(reason, claim)

    return {
        "evidence_class": evidence,
        "settlement": settlement,
        "final": final,
    }


FIELDS = ("evidence_class", "settlement", "final")


def compute(vec):
    try:
        got = build(vec["input"])
    except Refused as e:
        return {"id": vec["id"], "outcome": "REJECT", "code": e.code}
    except KeyError as e:
        return {"id": vec["id"], "outcome": "REJECT", "code": f"missing_input: {e}"}
    fields = [{"field": f, "computed": got[f]} for f in FIELDS]
    return {"id": vec["id"], "outcome": "ACCEPT", "fields": fields}


def main(argv):
    as_json = "--json" in argv
    args = [a for a in argv if not a.startswith("--")]
    if args:
        directory = pathlib.Path(args[0])
    else:
        directory = pathlib.Path(__file__).resolve().parent.parent / "vectors"
    files = sorted(directory.glob("known-answer-*.json"))
    if not files:
        print(f"no known-answer files in {directory}", file=sys.stderr)
        return 2

    records = [compute(json.loads(p.read_text())) for p in files]
    if as_json:
        print(json.dumps(records))
        return 0
    for r in records:
        if r["outcome"] == "REJECT":
            print(f"{r['id']:<48} REJECT {r['code']}")
        else:
            shown = " ".join(
                f"{f['field']}={json.dumps(f['computed'])}" for f in r["fields"]
            )
            print(f"{r['id']:<48} ACCEPT {shown}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
