/**
 * Standard x402 v2 HTTP transport (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
 * PAYMENT-RESPONSE) and the facilitator verify + settle calls.
 *
 * Wire format follows the x402 v2 spec: the 402 carries a base64-encoded
 * PaymentRequired object in the PAYMENT-REQUIRED header. The paid retry is
 * PAYMENT-SIGNATURE. Settlement is PAYMENT-RESPONSE. Older clients may send
 * the same v2 payload in X-PAYMENT, and the response is also copied to
 * X-PAYMENT-RESPONSE. Those names are aliases, not a second payment schema.
 * This file does not emit the SYCEE `gates_spec` challenge.
 *
 * The raw payment payload is sent to the facilitator and then dropped. It is
 * not returned and not written to the store.
 */

import { sha256 } from '@sycee/core';
import { serviceUrl } from './config.mjs';

const PAYMENT_HEADER_NAMES = ['payment-signature', 'x-payment', 'x-payment-signature', 'payment-proof'];
const KNOWN_REASONS = new Set([
  'invalid_signature',
  'wrong_amount',
  'wrong_recipient',
  'malformed_payload',
  'authorization_expired',
  'authorization_not_yet_valid',
  'insufficient_funds',
  'duplicate_payment',
  'nonce_already_used',
  'facilitator_timeout',
  'risk_policy_rejected',
  'commercial_refusal',
  'internal_error',
]);

/**
 * @param {Record<string, string>} headers lower-cased node-style headers
 */
export function readPaymentHeader(headers = {}) {
  for (const name of PAYMENT_HEADER_NAMES) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * @param {object} config
 * @param {string} resourceUrl absolute URL of the paid route, without a query
 */
export function paymentRequirements(config, resourceUrl) {
  return {
    scheme: 'exact',
    network: config.network,
    amount: config.priceAtomic,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: {
      name: config.assetName,
      version: config.assetVersion,
    },
  };
}

/**
 * @param {object} config
 * @param {string} resourceUrl
 * @param {string} [error]
 */
export function paymentRequired(config, resourceUrl, error = 'PAYMENT-SIGNATURE header is required') {
  return {
    x402Version: 2,
    error,
    resource: {
      url: resourceUrl,
      description: 'Latest Base block number, timestamp, and base fee',
      mimeType: 'application/json',
      serviceName: 'SYCEE demo merchant',
    },
    accepts: [paymentRequirements(config, resourceUrl)],
  };
}

export function encodeJsonHeader(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/**
 * v2 settlement header, plus the v1 name as an alias of the same bytes.
 * @param {{ setHeader(name: string, value: string): void }} res
 * @param {object} value
 */
export function writePaymentResponse(res, value) {
  const encoded = encodeJsonHeader(value);
  res.setHeader('payment-response', encoded);
  res.setHeader('x-payment-response', encoded);
}

export function decodeJsonHeader(value) {
  const text = Buffer.from(String(value), 'base64').toString('utf8');
  if (!text) throw new Error('empty');
  return JSON.parse(text);
}

/**
 * verifyPayment hook for createGates. Verify and settle both happen here,
 * before the handler runs. A second presentation of the same header is
 * verified (read-only) and refused without a second settle.
 *
 * @param {{
 *   config: object,
 *   store: { get(hash: string): Promise<any> },
 *   fetchImpl: typeof fetch,
 *   requirements: object,
 * }} deps
 */
export function createVerifyPayment(deps) {
  const { config, store, fetchImpl, requirements } = deps;

  return async function verifyPayment(proofHeader, req) {
    if (typeof proofHeader !== 'string' || proofHeader.length > 16_384) {
      return refuse(req, 'malformed_payload', config.network);
    }

    let payload;
    try {
      payload = decodeJsonHeader(proofHeader);
    } catch {
      return refuse(req, 'malformed_payload', config.network);
    }

    const shape = checkPayload(payload, config);
    if (!shape.ok) return refuse(req, shape.reason, config.network);

    const proofHash = sha256(proofHeader);
    const prior = await store.get(proofHash);
    const count = prior?.count ?? 1;

    if (count > 1) {
      const verified = await postFacilitator(fetchImpl, config, '/verify', payload, requirements, 10_000);
      if (!verified.ok) return refuse(req, verified.reason, config.network);
      return refuse(req, 'duplicate_payment', config.network);
    }

    const verified = await postFacilitator(fetchImpl, config, '/verify', payload, requirements, 10_000);
    if (!verified.ok) return refuse(req, verified.reason, config.network);
    if (!verified.body?.isValid) {
      return refuse(req, mapFacilitatorReason(verified.body?.invalidReason), config.network);
    }

    const block = await fetchBlock(fetchImpl, config);
    if (!block.ok) return refuse(req, 'internal_error', config.network);

    const settled = await postFacilitator(fetchImpl, config, '/settle', payload, requirements, 20_000);
    if (!settled.ok) return refuse(req, settled.reason, config.network);
    const tx = asTxHash(settled.body?.transaction);
    if (!settled.body?.success || !tx) {
      return refuse(req, mapFacilitatorReason(settled.body?.errorReason), config.network);
    }

    req.sycee = {
      block: block.block,
      tx,
      paymentResponse: {
        success: true,
        transaction: tx,
        network: config.network,
        ...(typeof settled.body.payer === 'string' ? { payer: settled.body.payer } : {}),
      },
    };
    return { ok: true, settlement: 'settled' };
  };
}

function refuse(req, reason, network) {
  req.sycee = {
    ...(req.sycee ?? {}),
    paymentResponse: {
      success: false,
      errorReason: reason,
      transaction: '',
      network,
    },
  };
  return { ok: false, reason };
}

function checkPayload(payload, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (payload.x402Version !== 2) return { ok: false, reason: 'malformed_payload' };
  const accepted = payload.accepted;
  const authorization = payload.payload?.authorization;
  const signature = payload.payload?.signature;
  if (!accepted || typeof accepted !== 'object') return { ok: false, reason: 'malformed_payload' };
  if (!authorization || typeof authorization !== 'object') return { ok: false, reason: 'malformed_payload' };
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{120,140}$/.test(signature)) {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (accepted.scheme !== 'exact') return { ok: false, reason: 'malformed_payload' };
  if (accepted.network !== config.network) return { ok: false, reason: 'malformed_payload' };
  if (!sameHex(authorization.to, config.payTo) || (accepted.payTo && !sameHex(accepted.payTo, config.payTo))) {
    return { ok: false, reason: 'wrong_recipient' };
  }
  if (!sameAmount(authorization.value, config.priceAtomic) || (accepted.amount && !sameAmount(accepted.amount, config.priceAtomic))) {
    return { ok: false, reason: 'wrong_amount' };
  }
  if (accepted.asset && !sameHex(accepted.asset, config.asset)) return { ok: false, reason: 'wrong_amount' };
  if (typeof authorization.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) {
    return { ok: false, reason: 'malformed_payload' };
  }
  return { ok: true };
}

async function postFacilitator(fetchImpl, config, suffix, paymentPayload, paymentRequirements, timeoutMs) {
  let url;
  try {
    url = serviceUrl(config.facilitatorUrl, suffix);
  } catch {
    return { ok: false, reason: 'internal_error' };
  }
  const body = {
    x402Version: paymentPayload.x402Version ?? 2,
    paymentPayload,
    paymentRequirements,
  };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err && /** @type {any} */ (err).name;
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'facilitator_timeout' };
    return { ok: false, reason: 'internal_error' };
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, reason: 'internal_error' };
  if (response.status === 408 || response.status === 504) return { ok: false, reason: 'facilitator_timeout' };
  let text;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: 'internal_error' };
  }
  if (text.length > 65_536) return { ok: false, reason: 'internal_error' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'internal_error' };
  }
  if (!response.ok && parsed && typeof parsed === 'object') {
    if (suffix === '/verify' && typeof parsed.isValid === 'boolean') return { ok: true, body: parsed };
    if (suffix === '/settle' && typeof parsed.success === 'boolean') return { ok: true, body: parsed };
    return { ok: false, reason: 'internal_error' };
  }
  return { ok: true, body: parsed };
}

async function fetchBlock(fetchImpl, config) {
  const check = config.rpcUrl;
  let response;
  try {
    response = await fetchImpl(check, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: ['latest', false],
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok || (response.status >= 300 && response.status < 400)) return { ok: false };
  let text;
  try {
    text = await response.text();
  } catch {
    return { ok: false };
  }
  if (text.length > 262_144) return { ok: false };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const block = parsed?.result;
  if (!block || typeof block !== 'object' || typeof block.number !== 'string' || typeof block.timestamp !== 'string') {
    return { ok: false };
  }
  if (typeof block.baseFeePerGas !== 'string') return { ok: false };
  const blockNumber = hexToSafeNumber(block.number);
  const seconds = hexToSafeNumber(block.timestamp);
  const fee = hexToDec(block.baseFeePerGas);
  if (blockNumber == null || seconds == null || fee == null) return { ok: false };
  return {
    ok: true,
    block: {
      block_number: blockNumber,
      timestamp: new Date(seconds * 1000).toISOString(),
      base_fee_per_gas: fee,
      network: config.network,
    },
  };
}

/**
 * Map a facilitator string onto the closed refusal set. Unknown text becomes
 * internal_error so a verbose upstream message is never stored or returned.
 * @param {unknown} raw
 */
export function mapFacilitatorReason(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return 'internal_error';
  if (KNOWN_REASONS.has(text)) return text;
  if (text.includes('insufficient')) return 'insufficient_funds';
  if (text.includes('expired') || text.includes('valid_before') || text.includes('validbefore')) {
    return 'authorization_expired';
  }
  if (text.includes('not_yet') || text.includes('valid_after') || text.includes('validafter')) {
    return 'authorization_not_yet_valid';
  }
  if (text.includes('nonce')) return 'nonce_already_used';
  if (text.includes('signature')) return 'invalid_signature';
  if (text.includes('recipient') || text.includes('payto') || text.includes('pay_to')) return 'wrong_recipient';
  if (text.includes('amount') || text.includes('_value')) return 'wrong_amount';
  if (text.includes('timeout') || text.includes('timed out')) return 'facilitator_timeout';
  if (text.includes('malformed') || text.includes('schema')) return 'malformed_payload';
  return 'internal_error';
}

function sameHex(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function sameAmount(got, expected) {
  try {
    return BigInt(got) === BigInt(expected);
  } catch {
    return false;
  }
}

function asTxHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
}

function hexToDec(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  return BigInt(hex).toString(10);
}

function hexToSafeNumber(hex) {
  const dec = hexToDec(hex);
  if (dec == null) return null;
  const n = Number(dec);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}
