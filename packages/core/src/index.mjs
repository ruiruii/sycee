/**
 * @sycee/core — SYCEE v0.1 reference primitives.
 *
 * Zero dependencies. Node >= 18.
 *
 * Three jobs only:
 *   1. canonical JSON serialization (RFC 8785 / JCS compatible for this subset)
 *   2. SHA-256 hashing with `sha256:` prefix
 *   3. Ed25519 sign / offline verify over the VSR envelope
 *
 * It never sees a payment proof body. Only hashes cross this boundary.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from 'node:crypto';

export const SCHEMA_VERSION = 'sycee/v0.1';

/* ------------------------------------------------------------------ *
 * 1. Canonical JSON
 * ------------------------------------------------------------------ */

/**
 * Serialize a value to canonical JSON bytes.
 *
 * - UTF-8, no whitespace, no trailing newline
 * - object keys sorted lexicographically by code point, recursively
 * - array order preserved
 * - numbers via ECMAScript Number::toString (shortest round-trippable)
 *
 * @param {unknown} value
 * @returns {string} canonical JSON text
 */
export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
      return value;
    }
    if (typeof value === 'bigint') throw new TypeError('canonical JSON: BigInt not allowed');
    if (typeof value === 'undefined') throw new TypeError('canonical JSON: undefined not allowed');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** Canonical bytes as a Buffer (UTF-8). */
export function canonicalBytes(value) {
  return Buffer.from(canonicalJSON(value), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 2. Hashing
 * ------------------------------------------------------------------ */

/**
 * SHA-256 with the `sha256:` prefix used throughout SYCEE.
 * @param {string|Buffer} input
 * @returns {string} `sha256:<64 hex>`
 */
export function sha256(input) {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

/**
 * Request fingerprint: H(method + " " + url + " " + canonical params).
 * @param {{method: string, url: string, params?: Record<string, unknown>}} req
 */
export function requestFingerprint({ method, url, params = {} }) {
  return sha256(`${String(method).toUpperCase()} ${url} ${canonicalJSON(params)}`);
}

/* ------------------------------------------------------------------ *
 * 3. Keys
 * ------------------------------------------------------------------ */

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}
function unb64u(str) {
  return Buffer.from(String(str), 'base64url');
}

/**
 * Generate an Ed25519 keypair.
 * @returns {{publicKey: string, privateKey: string}}
 *   publicKey  — `ed25519:<base64url SPKI DER>`
 *   privateKey — `ed25519-priv:<base64url PKCS#8 DER>`
 */
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: `ed25519:${b64u(publicKey)}`,
    privateKey: `ed25519-priv:${b64u(privateKey)}`,
  };
}

/**
 * Deterministic Ed25519 keypair from a 32-byte seed (64 hex chars).
 * Used to generate reproducible conformance vectors.
 * @param {string} seedHex 64 hex characters
 */
export function generateKeyPairFromSeed(seedHex) {
  const seed = Buffer.from(String(seedHex), 'hex');
  if (seed.length !== 32) {
    throw new TypeError('generateKeyPairFromSeed: seed must be 32 bytes (64 hex chars)');
  }
  // PKCS#8 wrapper for an Ed25519 private key: prefix + raw 32-byte seed
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  return {
    publicKey: `ed25519:${b64u(pub.export({ type: 'spki', format: 'der' }))}`,
    privateKey: `ed25519-priv:${b64u(priv.export({ type: 'pkcs8', format: 'der' }))}`,
  };
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Load a private key reference into a node KeyObject. */
export function loadPrivateKey(ref) {
  const raw = String(ref).replace(/^ed25519-priv:/, '');
  return createPrivateKey({ key: unb64u(raw), format: 'der', type: 'pkcs8' });
}

/** Load a public key reference into a node KeyObject. */
export function loadPublicKey(ref) {
  const raw = String(ref).replace(/^ed25519:/, '');
  return createPublicKey({ key: unb64u(raw), format: 'der', type: 'spki' });
}

/* ------------------------------------------------------------------ *
 * 4. Envelope assembly
 * ------------------------------------------------------------------ */

/**
 * Build an unsigned VSR `vsr` object.
 *
 * Defaults are conservative: `result.consumed` is `unknown` unless the caller
 * can actually demonstrate downstream reference. `unknown` is never `yes`.
 *
 * @param {{
 *   protocol: string,
 *   resourceId: string,
 *   proofHash: string,
 *   redeemCount: number,
 *   settlementStatus?: 'settled'|'in_flight'|'absent',
 *   deliveryStatus?: 'delivered'|'partial'|'failed'|'timeout',
 *   deliveredAt?: string,
 *   consumed?: 'yes'|'no'|'unknown',
 *   consumedBy?: string[],
 *   consumedAt?: string,
 *   publicKey: string,
 *   agentId?: string,
 *   keyId?: string,
 *   role: 'merchant'|'agent'|'observer',
 *   extra?: Record<string, unknown>
 * }} input
 */
export function buildVSR(input) {
  const deliveredAt = input.deliveredAt ?? nowISO();
  const consumed = input.consumed ?? 'unknown';
  const consumedAt = consumed === 'yes' ? (input.consumedAt ?? nowISO()) : undefined;

  const vsr = {
    schema_version: SCHEMA_VERSION,
    protocol: input.protocol,
    resource_id: input.resourceId,
    payment: {
      proof_hash: input.proofHash,
      redeem_count: Number(input.redeemCount ?? 1),
      settlement_status: input.settlementStatus ?? 'in_flight',
    },
    delivery: {
      status: input.deliveryStatus ?? 'delivered',
      delivered_at: deliveredAt,
    },
    result: {
      consumed,
    },
    signer: {
      public_key: input.publicKey,
      role: input.role,
    },
  };

  if (input.requestFingerprint) vsr.request_fingerprint = input.requestFingerprint;
  if (input.tradeNo) vsr.payment.trade_no = input.tradeNo;
  if (input.proofSeenAt) vsr.payment.proof_seen_at = input.proofSeenAt;
  if (input.completeSeenAt) vsr.payment.complete_seen_at = input.completeSeenAt;
  if (input.redeemResources) vsr.payment.redeem_resources = input.redeemResources;
  if (input.amount) vsr.amount = input.amount;
  if (input.bytes !== undefined) vsr.delivery.bytes = input.bytes;
  if (consumedBy(input)) vsr.result.consumed_by = input.consumedBy;
  if (consumedAt) {
    vsr.result.consumed_at = consumedAt;
    vsr.result.freshness_s = freshnessSeconds(deliveredAt, consumedAt);
  }
  if (input.agentId) vsr.signer.agent_id = input.agentId;
  if (input.keyId) vsr.signer.key_id = input.keyId;
  if (input.completeness) vsr.completeness = input.completeness;
  if (input.extra) Object.assign(vsr, input.extra);

  // keep key order stable & canonical for signing
  return JSON.parse(canonicalJSON(vsr));
}

function consumedBy(input) {
  return Array.isArray(input.consumedBy) && input.consumedBy.length > 0;
}

/**
 * Sign a VSR object, producing a complete envelope `{ vsr, signature }`.
 * @param {object} vsr
 * @param {string} privateKeyRef
 */
export function signVSR(vsr, privateKeyRef) {
  const payload = canonicalBytes(vsr);
  const sig = ed25519Sign(null, payload, loadPrivateKey(privateKeyRef));
  return { vsr, signature: b64u(sig) };
}

/* ------------------------------------------------------------------ *
 * 5. Offline verification
 * ------------------------------------------------------------------ */

const CONSUMED_VALUES = new Set(['yes', 'no', 'unknown']);
const DELIVERY_STATUS = new Set(['delivered', 'partial', 'failed', 'timeout']);
const PROTOCOLS = new Set([
  'x402', 'mpp', 'ap2', 'alipay-a2m', 'apop', 'a2p2', 'card-a2a', 'other',
]);
const ROLES = new Set(['merchant', 'agent', 'observer']);

/** The settlement predicate has exactly three values (SPEC §5.1). */
export const SETTLEMENT_STATUS = new Set(['settled', 'in_flight', 'absent']);

/**
 * Map a transport's own wire value onto the spec enum.
 *
 * Documented mappings (SPEC §5.1):
 *   true | 'true' | 'settled' | 'ok' | 'confirmed'   -> 'settled'
 *   'queued' | 'pending' | 'in_flight' | unknown      -> 'in_flight'
 *   false | 'false' | 'absent' | 'none' | 'not_found' -> 'absent'
 *
 * A signal the seller never received (`null` / `undefined` / unknown) falls back to
 * `in_flight`: "not yet observable" is not "not settled".
 *
 * @param {unknown} wire
 * @returns {'settled'|'in_flight'|'absent'}
 */
export function normalizeSettlement(wire) {
  if (SETTLEMENT_STATUS.has(/** @type {string} */ (wire))) {
    return /** @type {'settled'|'in_flight'|'absent'} */ (wire);
  }
  if (wire === undefined || wire === null) return 'in_flight';
  if (wire === true) return 'settled';
  if (wire === false) return 'absent';
  const v = String(wire).trim().toLowerCase();
  if (v === 'true' || v === 'ok' || v === 'confirmed' || v === 'complete') return 'settled';
  if (v === 'false' || v === 'absent' || v === 'none' || v === 'not_found') return 'absent';
  return 'in_flight';
}

/**
 * Cross-check the settlement predicate against the delivery claim (SPEC §5.1).
 *
 * The two are orthogonal — this only reports whether the *pair* is coherent.
 *
 * @param {{ deliveryStatus?: string, settlementStatus?: string }} input
 * @returns {'ok'|'incomplete'|'contradiction'}
 */
export function settlementConsistency({ deliveryStatus = 'delivered', settlementStatus = 'in_flight' }) {
  if (settlementStatus === 'absent' && deliveryStatus === 'delivered') return 'contradiction';
  if (settlementStatus !== 'settled') return 'incomplete';
  return 'ok';
}

/**
 * Verify a VSR envelope offline. No network, no rail, no issuer contact.
 *
 * By default this answers "is this receipt internally coherent and correctly signed?".
 * Pass `requireSettled: true` to also demand a settled payment — that is the fail-closed
 * mode: `in_flight` and `absent` then make `valid` false, with a distinguishable reason.
 *
 * @param {unknown} envelope
 * @param {{ now?: number, maxSkewMs?: number, requireSettled?: boolean, allowUnpaidDelivery?: boolean }} [opts]
 * @returns {{ valid: boolean, errors: string[], warnings: string[], level: 'L0'|'L1'|'L2'|'invalid',
 *            settlement: { status: string, finalized: boolean, consistency: string } }}
 */
export function verifyVSR(envelope, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, errors: ['envelope: not an object'], warnings, level: 'invalid' };
  }

  const { vsr, signature } = /** @type {any} */ (envelope);
  if (!vsr || typeof vsr !== 'object') {
    return { valid: false, errors: ['vsr: missing or not an object'], warnings, level: 'invalid' };
  }

  // --- structural checks (normative, SPEC section 6.1) -----------------
  if (vsr.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version: expected ${SCHEMA_VERSION}, got ${String(vsr.schema_version)}`);
  }
  if (!PROTOCOLS.has(vsr.protocol)) {
    warnings.push(`protocol: unregistered value ${String(vsr.protocol)}`);
  }
  if (typeof vsr.resource_id !== 'string' || vsr.resource_id.length === 0) {
    errors.push('resource_id: required non-empty string');
  }

  const payment = vsr.payment ?? {};
  if (typeof payment.proof_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(payment.proof_hash)) {
    errors.push('payment.proof_hash: required, must be sha256:<64 hex>');
  }
  if (!Number.isInteger(payment.redeem_count) || payment.redeem_count < 1) {
    errors.push('payment.redeem_count: required integer >= 1');
  }
  if (payment.redeem_count > 1) {
    warnings.push(
      `payment.redeem_count = ${payment.redeem_count}: one payment proof was redeemed more than once`,
    );
  }

  // --- settlement predicate (SPEC §5.1) ---------------------------------
  const delivery = vsr.delivery ?? {};
  if (!DELIVERY_STATUS.has(delivery.status)) {
    errors.push('delivery.status: must be delivered | partial | failed | timeout');
  }

  // A missing field means "the seller could not determine it". Per §5.1 the
  // default is in_flight, not absent: "not yet observable" is not "not settled".
  const settlementStatus = payment.settlement_status === undefined
    ? 'in_flight'
    : payment.settlement_status;
  if (!SETTLEMENT_STATUS.has(settlementStatus)) {
    errors.push(
      `payment.settlement_status: must be settled | in_flight | absent, got ${String(payment.settlement_status)}`,
    );
  }
  const consistency = settlementConsistency({ deliveryStatus: delivery.status, settlementStatus });
  if (settlementStatus === 'in_flight') {
    warnings.push(
      'payment.settlement_status = in_flight: payment observed but not confirmed; treat as unproven, not refuted',
    );
  }
  if (settlementStatus === 'absent') {
    warnings.push('payment.settlement_status = absent: no transaction found for the claimed proof');
  }
  if (settlementStatus === 'settled' && (delivery.status === 'failed' || delivery.status === 'timeout')) {
    warnings.push(
      `settled but delivery.status = ${delivery.status}: paid without fulfilment — dispute material`,
    );
  }
  if (consistency === 'contradiction') {
    const msg =
      'payment.settlement_status = absent with delivery.status = delivered: contradiction — ' +
      'bytes claimed for a payment that has no transaction';
    if (opts.allowUnpaidDelivery) warnings.push(msg);
    else errors.push(msg);
  }
  if (opts.requireSettled && settlementStatus !== 'settled') {
    errors.push(
      `payment.settlement_status = ${settlementStatus}: requireSettled is set and the payment is not confirmed`,
    );
  }

  const result = vsr.result ?? {};
  if (!CONSUMED_VALUES.has(result.consumed)) {
    errors.push('result.consumed: must be yes | no | unknown');
  }
  if (result.consumed === 'unknown') {
    warnings.push('result.consumed = unknown: buyer runtime did not instrument downstream context');
  }
  if (result.consumed === 'yes' && !Array.isArray(result.consumed_by)) {
    warnings.push('result.consumed = yes without consumed_by evidence: assertion, not attestation');
  }
  if (result.consumed === 'no') {
    warnings.push('result.consumed = no: delivered but never referenced — idle spend');
  }

  const signer = vsr.signer ?? {};
  if (typeof signer.public_key !== 'string' || !signer.public_key.startsWith('ed25519:')) {
    errors.push('signer.public_key: required, format ed25519:<base64url>');
  }
  if (!ROLES.has(signer.role)) {
    errors.push('signer.role: must be merchant | agent | observer');
  }

  // --- red line: proof bodies must never appear -------------------------
  const raw = JSON.stringify(vsr);
  for (const forbidden of ['PAYMENT-SIGNATURE', 'payment_proof', 'X-PAYMENT']) {
    if (raw.includes(forbidden)) {
      errors.push(`red line: envelope appears to embed a raw payment credential (${forbidden})`);
    }
  }

  // --- signature --------------------------------------------------------
  let signed = false;
  if (typeof signature === 'string' && signature.length > 0) {
    signed = true;
    if (!errors.some((e) => e.startsWith('signer.public_key'))) {
      try {
        const ok = ed25519Verify(
          null,
          canonicalBytes(vsr),
          loadPublicKey(signer.public_key),
          unb64u(signature),
        );
        if (!ok) errors.push('signature: Ed25519 verification failed');
      } catch (err) {
        errors.push(`signature: verification error — ${/** @type {Error} */ (err).message}`);
      }
    }
  } else {
    warnings.push('signature: absent — L0 telemetry only, not a verifiable receipt');
  }

  const level = errors.length ? 'invalid' : !signed ? 'L0' : vsr.completeness === 'bilateral' ? 'L2' : 'L1';
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    level,
    settlement: {
      status: settlementStatus,
      finalized: settlementStatus === 'settled',
      consistency,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 6. OTel span attribute export
 * ------------------------------------------------------------------ */

/**
 * Flatten a VSR into OpenTelemetry span attributes (`agent.spend.*`).
 * @param {object} vsr
 * @returns {Record<string, string|number|string[]>}
 */
export function toSpanAttributes(vsr) {
  const p = vsr.payment ?? {};
  const d = vsr.delivery ?? {};
  const r = vsr.result ?? {};
  const s = vsr.signer ?? {};
  const settlementStatus = normalizeSettlement(p.settlement_status);
  /** @type {Record<string, string|number|string[]>} */
  const attrs = {
    'agent.spend.protocol': vsr.protocol,
    'agent.spend.resource.id': vsr.resource_id,
    'agent.spend.payment.proof_hash': p.proof_hash,
    'agent.spend.payment.redeem_count': p.redeem_count,
    'agent.spend.payment.settlement_status': settlementStatus,
    'agent.spend.delivery.status': d.status,
    'agent.spend.result.consumed': r.consumed,
  };
  attrs['agent.spend.settlement.consistency'] = settlementConsistency({
    deliveryStatus: d.status ?? 'delivered',
    settlementStatus,
  });
  if (vsr.request_fingerprint) attrs['agent.spend.request.fingerprint'] = vsr.request_fingerprint;
  if (p.proof_seen_at) attrs['agent.spend.payment.proof_seen_at'] = p.proof_seen_at;
  if (p.complete_seen_at) attrs['agent.spend.payment.complete_seen_at'] = p.complete_seen_at;
  if (p.trade_no) attrs['agent.spend.payment.trade_no'] = p.trade_no;
  if (p.redeem_resources) attrs['agent.spend.payment.redeem_resources'] = p.redeem_resources;
  if (d.delivered_at) attrs['agent.spend.delivery.delivered_at'] = d.delivered_at;
  if (d.bytes !== undefined) attrs['agent.spend.delivery.bytes'] = d.bytes;
  if (r.consumed_by) attrs['agent.spend.result.consumed_by'] = r.consumed_by;
  if (r.consumed_at) attrs['agent.spend.result.consumed_at'] = r.consumed_at;
  if (r.freshness_s !== undefined) attrs['agent.spend.result.freshness_s'] = r.freshness_s;
  if (vsr.amount?.value) attrs['agent.spend.amount.value'] = vsr.amount.value;
  if (vsr.amount?.currency) attrs['agent.spend.amount.currency'] = vsr.amount.currency;
  if (s.agent_id) attrs['agent.spend.signer.agent_id'] = s.agent_id;
  if (s.role) attrs['agent.spend.signer.role'] = s.role;
  if (vsr.completeness) attrs['agent.spend.completeness'] = vsr.completeness;
  return attrs;
}

/* ------------------------------------------------------------------ *
 * 7. Utilities
 * ------------------------------------------------------------------ */

export function nowISO() {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, '$1Z');
}

/** Whole seconds from delivered_at to consumed_at. Clamped at 0. */
export function freshnessSeconds(deliveredAt, consumedAt) {
  const a = Date.parse(deliveredAt);
  const b = Date.parse(consumedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}

export {
  REFUSAL_SCHEMA_VERSION,
  REFUSAL_REASONS,
  REASON_CEILING,
  EVIDENCE_ORDER,
  DECISIONS,
  SETTLEMENT_STATES,
  ceilingFor,
  withinCeiling,
  signingKeyCheck,
  finalityCheck,
  classifyRepeat,
  attemptIdentity,
  refusalRow,
  signRefusal,
  mergeRow,
  refusalLedger,
  exportClaim,
  verifyClaim,
} from './refusal.mjs';
