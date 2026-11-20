"""Conformance tests for the independent Python verifier.

Run from the repository root:

    python3 -m pytest
    python3 -m unittest discover python/tests
"""

from __future__ import annotations

import base64
import json
import sys
import unittest
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PYTHON_DIR.parent
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from sycee_verify import canonical_bytes, canonical_json, verify_envelope  # noqa: E402

VECTORS = REPO_ROOT / "conformance" / "vectors"
MANIFEST = json.loads((VECTORS / "manifest.json").read_text(encoding="utf-8"))
EXPECTED = {case["file"]: case for case in MANIFEST["cases"]}


def load(name: str) -> dict:
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


def case_name(name: str) -> dict:
    return EXPECTED[name]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def public_key_ref(public_key) -> str:
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    der = public_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return "ed25519:" + b64url(der)


class VectorTests(unittest.TestCase):
    """One test per conformance vector, checked against manifest.json."""

    def assert_vector(self, name: str) -> None:
        expected = case_name(name)
        report = verify_envelope(load(name))
        self.assertEqual(report.level, expected["level"], name)
        self.assertEqual(report.schema_valid, expected["schemaValid"], name)
        self.assertEqual(report.signature_valid, expected["signatureValid"], name)
        if expected["level"] in ("L1", "L2"):
            self.assertTrue(report.accepted, name)
        else:
            self.assertFalse(report.accepted, name)

    def test_valid_consumed_yes(self):
        self.assert_vector("valid-consumed-yes.json")

    def test_valid_consumed_unknown(self):
        self.assert_vector("valid-consumed-unknown.json")

    def test_valid_consumed_no_idle_spend(self):
        self.assert_vector("valid-consumed-no-idle-spend.json")

    def test_valid_redeem_count_3(self):
        self.assert_vector("valid-redeem-count-3.json")

    def test_valid_agent_side_bilateral(self):
        self.assert_vector("valid-agent-side-bilateral.json")

    def test_valid_settlement_in_flight(self):
        self.assert_vector("valid-settlement-in-flight.json")

    def test_valid_settlement_settled_undelivered(self):
        self.assert_vector("valid-settlement-settled-undelivered.json")

    def test_invalid_settlement_absent_delivered(self):
        self.assert_vector("invalid-settlement-absent-delivered.json")
        report = verify_envelope(load("invalid-settlement-absent-delivered.json"))
        self.assertIn("settlement_contradiction", report.error_codes())

    def test_invalid_missing_consumed(self):
        self.assert_vector("invalid-missing-consumed.json")
        report = verify_envelope(load("invalid-missing-consumed.json"))
        self.assertIn("missing_required", report.error_codes())

    def test_invalid_tampered_redeem_count(self):
        self.assert_vector("invalid-tampered-redeem-count.json")
        report = verify_envelope(load("invalid-tampered-redeem-count.json"))
        self.assertIn("signature_invalid", report.error_codes())

    def test_invalid_embedded_proof(self):
        self.assert_vector("invalid-embedded-proof.json")
        report = verify_envelope(load("invalid-embedded-proof.json"))
        self.assertIn("embedded_payment_proof", report.error_codes())

    def test_invalid_unsigned_l0(self):
        self.assert_vector("invalid-unsigned-l0.json")
        report = verify_envelope(load("invalid-unsigned-l0.json"))
        self.assertEqual(report.level, "L0")
        self.assertFalse(report.signature_valid)
        self.assertFalse(report.accepted)


class DegenerateImplementationTests(unittest.TestCase):
    """A verifier that skipped these checks would accept a broken receipt."""

    def test_single_hex_digit_hash_change_is_rejected(self):
        envelope = load("valid-consumed-yes.json")
        original = envelope["vsr"]["payment"]["proof_hash"]
        last = original[-1]
        envelope["vsr"]["payment"]["proof_hash"] = original[:-1] + ("0" if last != "0" else "1")
        report = verify_envelope(envelope)
        self.assertFalse(report.accepted)
        self.assertEqual(report.level, "invalid")
        self.assertIn("signature_invalid", report.error_codes())

    def test_truncated_signature_is_rejected(self):
        envelope = load("valid-consumed-yes.json")
        envelope["signature"] = envelope["signature"][:-8]
        report = verify_envelope(envelope)
        self.assertFalse(report.accepted)
        self.assertEqual(report.level, "invalid")
        self.assertIn("signature_invalid", report.error_codes())

    def test_merchant_cannot_upgrade_consumed_to_yes(self):
        # Re-sign with a throwaway key so the *only* defect is the role rule:
        # §5.3 forbids a merchant from self-reporting consumed = yes when the
        # result block is not bilaterally co-signed.
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        envelope = load("valid-consumed-unknown.json")
        self.assertEqual(envelope["vsr"]["signer"]["role"], "merchant")
        self.assertEqual(envelope["vsr"]["completeness"], "unilateral_merchant")

        private_key = Ed25519PrivateKey.generate()
        vsr = envelope["vsr"]
        vsr["signer"]["public_key"] = public_key_ref(private_key.public_key())
        vsr["result"]["consumed"] = "yes"

        forged = {
            "vsr": vsr,
            "signature": b64url(private_key.sign(canonical_bytes(vsr))),
        }
        report = verify_envelope(forged)
        self.assertFalse(report.accepted)
        self.assertEqual(report.level, "invalid")
        self.assertIn("role_conflict", report.error_codes())


class CanonicalJsonTests(unittest.TestCase):
    """SPEC.md §7.1: sorted keys, no whitespace, ECMAScript numbers, UTF-8."""

    def test_sorted_keys_and_no_whitespace(self):
        value = {"b": 1, "a": {"d": 2, "c": [3, {"z": 4, "y": 5}]}}
        self.assertEqual(canonical_json(value), '{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}')

    def test_ecmascript_number_formatting(self):
        self.assertEqual(canonical_json(3.0), "3")
        self.assertEqual(canonical_json(-0.0), "0")
        self.assertEqual(canonical_json(1e-6), "0.000001")
        self.assertEqual(canonical_json(1e-7), "1e-7")
        self.assertEqual(canonical_json(1e21), "1e+21")
        self.assertEqual(canonical_json(4821), "4821")

    def test_utf8_without_ascii_escapes(self):
        self.assertEqual(canonical_json({"q": "支付"}), '{"q":"支付"}')
        self.assertEqual(canonical_bytes({"q": "支付"}), b'{"q":"\xe6\x94\xaf\xe4\xbb\x98"}')

    def test_canonical_form_is_stable_under_reparse(self):
        # The manifest's valid vectors are signed over exactly these bytes; a
        # canonicalizer that differs by one byte would fail every signature.
        envelope = load("valid-consumed-yes.json")
        blob = canonical_bytes(envelope["vsr"])
        self.assertEqual(canonical_bytes(json.loads(blob)), blob)


if __name__ == "__main__":
    unittest.main()
