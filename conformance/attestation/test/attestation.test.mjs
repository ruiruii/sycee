import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verify as edVerify } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJSON, sha256, loadPublicKey } from '../../../packages/core/src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const schema = JSON.parse(readFileSync(join(root, 'schema/reconcile-attestation-v0.1.schema.json'), 'utf8'));
const example = JSON.parse(readFileSync(join(root, 'docs/notes/reconciliation-attestation.example.json'), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

test('the example validates against the published schema', () => {
  const ok = validate(example);
  assert.equal(ok, true, JSON.stringify(validate.errors, null, 2));
});

test('attestation_id is recomputable from the document alone', () => {
  const { attestation_id, ...rest } = example.attestation;
  assert.equal(sha256(canonicalJSON(rest)), attestation_id);
});

test('the signature verifies under the key the document names', () => {
  const ok = edVerify(
    null,
    Buffer.from(canonicalJSON(example.attestation), 'utf8'),
    loadPublicKey(example.attestation.signer.public_key),
    Buffer.from(example.signature, 'base64url'),
  );
  assert.equal(ok, true);
});

test('changing one member without re-signing breaks the signature', () => {
  const tampered = structuredClone(example.attestation);
  tampered.divergence.members = ['path'];
  const ok = edVerify(
    null,
    Buffer.from(canonicalJSON(tampered), 'utf8'),
    loadPublicKey(example.attestation.signer.public_key),
    Buffer.from(example.signature, 'base64url'),
  );
  assert.equal(ok, false);
});

test('the schema rejects an adjudication field', () => {
  const bad = structuredClone(example);
  bad.attestation.divergence.fault = 'seller';
  assert.equal(validate(bad), false);
});

test('the schema rejects a verdict that names a culprit', () => {
  const bad = structuredClone(example);
  bad.attestation.divergence.verdict = 'seller_at_fault';
  assert.equal(validate(bad), false);
});

test('the schema rejects a seller-signed attestation', () => {
  const bad = structuredClone(example);
  bad.attestation.signer.role = 'merchant';
  assert.equal(validate(bad), false);
});

test('the schema rejects a verified claim with no receipt hash', () => {
  const bad = structuredClone(example);
  bad.attestation.subject.seller_receipt_hash = null;
  assert.equal(bad.attestation.subject.receipt_status, 'verified');
  assert.equal(validate(bad), false);
});

test('the schema rejects an absent claim that still carries a receipt hash', () => {
  const bad = structuredClone(example);
  bad.attestation.subject.receipt_status = 'absent';
  assert.equal(validate(bad), false);
});

test('a query digest passes the schema — R3 is normative, not structural', () => {
  const bad = structuredClone(example);
  bad.attestation.observation.members.query = sha256('q=invoice+status');
  // The schema allows this shape; the rule that forbids it is normative, so this
  // test records the gap rather than pretending the schema closes it.
  assert.equal(validate(bad), true);
});
