/**
 * First-party SYCEE demo merchant.
 *
 * Unpaid GET /v1/base/tip returns a standard x402 v2 402 (PAYMENT-REQUIRED).
 * A paid retry is handled by @sycee/middleware createGates. The verifyPayment
 * hook calls the facilitator /verify and /settle. The middleware counts the
 * proof hash, refuses a replay, and signs a merchant VSR with consumed=unknown.
 *
 * The raw PAYMENT-SIGNATURE value is hashed and then discarded. It is not
 * written to the store, the dashboard, or evidence.json.
 */

import { linkReceipts } from '@sycee/agent-sdk';
import { verifyVSR } from '@sycee/core';
import { createGates } from '@sycee/middleware';
import { anchorSignedReceipt, lookupAnchor } from './anchor.mjs';
import {
  RESOURCE_PATH,
  clientIp,
  keyProblems,
  loadMerchantKeys,
  readConfig,
  readNearConfig,
  trafficClass,
} from './config.mjs';
import { presentEvidence, renderDashboard, truncateProofHash } from './evidence.mjs';
import { digestHex, judgeReceipt, receiptHash } from './fingerprint.mjs';
import { d1Store, memoryStore } from './store.mjs';
import {
  createVerifyPayment,
  encodeJsonHeader,
  paymentRequired,
  paymentRequirements,
  readPaymentHeader,
  writePaymentResponse,
} from './x402.mjs';

const BLOCKING = new Set([
  'signing_key_missing',
  'signing_key_malformed',
  'signing_key_mismatch',
  'signing_key_is_payee',
  'pay_to_missing',
  'pay_to_malformed',
  'mainnet_disabled',
  'testnet_facilitator',
  'bad_facilitator_url',
  'bad_rpc_url',
  'bad_asset',
  'bad_asset_domain',
  'bad_price',
]);

const BANNED_KEYS = new Set([
  'authorization',
  'paymentpayload',
  'payment_payload',
  'payment-signature',
  'payment_signature',
  'x-payment',
  'proof',
]);

/**
 * @param {Record<string, any>} env
 */
export async function createMerchant(env = {}) {
  const config = readConfig(env);
  const keys = loadMerchantKeys(env);
  const problems = [];
  if (keys.error) problems.push(keys.error);
  if (keys.publicKey) problems.push(...keyProblems({ publicKey: keys.publicKey, payTo: config.payTo }));
  problems.push(...config.problems);

  const near = readNearConfig(env);
  near.sourceChain = config.network;
  near.merchantId = config.payTo || config.agentId;
  const opened = await openStore(env);
  const fetchImpl = env.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const uniqueProblems = [...new Set(problems)];

  if (keys.ephemeral) {
    console.warn(`SYCEE demo merchant ephemeral signing key. public_key=${keys.publicKey}`);
  }

  const merchant = {
    config,
    store: opened.store,
    storeKind: opened.kind,
    publicKey: keys.publicKey ?? null,
    problems: uniqueProblems,
    /** @type {{ total: number, accepted: number, refused: number } | null} */
    lastTally: null,
    near,
    fetch(request) {
      return handle(request, {
        config,
        store: opened.store,
        storeKind: opened.kind,
        publicKey: keys.publicKey ?? null,
        keys,
        problems: uniqueProblems,
        fetchImpl,
        near,
        anchorImpl: env.anchorImpl ?? null,
        merchant,
      });
    },
  };
  return merchant;
}

async function openStore(env) {
  if (env.DB && typeof env.DB.prepare === 'function') {
    return { store: d1Store(env.DB), kind: env.DB_KIND || 'd1' };
  }
  return { store: memoryStore(), kind: 'memory' };
}

async function handle(request, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return empty(204);

  try {
    if (url.pathname === '/health' && request.method === 'GET') return health(ctx);
    if (url.pathname === '/' && request.method === 'GET') return dashboard(ctx);
    if (url.pathname === '/evidence.json' && request.method === 'GET') return evidence(ctx);
    if ((url.pathname === '/evidence' || url.pathname === '/evidence.html') && request.method === 'GET') {
      return evidencePanel();
    }
    if (url.pathname === '/receipts.json' && request.method === 'GET') return receipts(ctx);
    if (url.pathname === '/v1/verify' && request.method === 'POST') return verifyReceipt(request, ctx);
    if (url.pathname === '/v1/verify') return json(405, { error: 'method_not_allowed' });
    if (url.pathname === '/.well-known/sycee.json' && request.method === 'GET') return wellKnown(ctx, url);
    if (url.pathname === RESOURCE_PATH) return paid(request, ctx, url);
    if (url.pathname === '/v1/agent-receipt' && request.method === 'POST') return agentReceipt(request, ctx);
    if (url.pathname === '/v1/agent-receipt') return json(405, { error: 'method_not_allowed' });
    return json(404, { error: 'not_found' });
  } catch (err) {
    if (err && err.code === 'database_not_initialized') {
      console.error('database_not_initialized');
      return json(503, { error: 'database_not_initialized' });
    }
    console.error('demo_merchant_error');
    return json(500, { error: 'internal_error' });
  }
}

function health(ctx) {
  return json(200, {
    ok: true,
    service: 'sycee-demo-merchant',
    configured: blocking(ctx).length === 0,
    store: ctx.storeKind,
    mainnet: ctx.config.mainnetEnabled === true,
    anchoring: ctx.near.enabled === true,
  });
}

async function dashboard(ctx) {
  const view = presentEvidence(ctx.config, await ctx.store.stats(), meta(ctx));
  return new Response(renderDashboard(view), {
    status: 200,
    headers: common({ 'content-type': 'text/html; charset=utf-8' }),
  });
}

async function evidence(ctx) {
  const view = presentEvidence(ctx.config, await ctx.store.stats(), meta(ctx));
  return json(200, view);
}

function wellKnown(ctx, url) {
  return json(200, {
    schema: 'sycee/v0.1',
    role: 'merchant',
    service: 'sycee-demo-merchant',
    statement: 'Records only. No scoring, no custody, no fund movement.',
    agent_id: ctx.config.agentId,
    public_key: ctx.publicKey,
    price: { value: ctx.config.priceDisplay, currency: ctx.config.currency, atomic: ctx.config.priceAtomic },
    network: ctx.config.network,
    asset: ctx.config.asset || null,
    pay_to: ctx.config.payTo || null,
    facilitator: ctx.config.facilitatorUrl,
    resource_id: ctx.config.resourceId,
    paid_path: RESOURCE_PATH,
    resource_url: `${url.origin}${RESOURCE_PATH}`,
    evidence_panel: `${url.origin}/evidence`,
    receipts: `${url.origin}/receipts.json`,
    mainnet_enabled: ctx.config.mainnetEnabled,
    configured: blocking(ctx).length === 0,
    near: ctx.near.public,
  });
}

async function paid(request, ctx, url) {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const blocked = blocking(ctx);
  if (blocked.length) return json(503, { error: blocked[0], problems: blocked });

  const limit = await ctx.store.rateLimit(`tip:${clientIp(request)}`, ctx.config.rateLimitPerMinute, 60_000);
  if (!limit.allowed) return json(429, { error: 'rate_limited' }, { 'retry-after': '60' });

  const nodeReq = toNodeReq(request);
  const proof = readPaymentHeader(nodeReq.headers);
  const resourceUrl = `${url.origin}${url.pathname}`;
  if (!proof) {
    const required = paymentRequired(ctx.config, resourceUrl);
    return json(402, required, { 'payment-required': encodeJsonHeader(required) });
  }

  const requirements = paymentRequirements(ctx.config, resourceUrl);
  const gates = createGates({
    resourceId: ctx.config.resourceId,
    protocol: 'x402',
    price: { value: ctx.config.priceDisplay, currency: ctx.config.currency },
    publicKey: ctx.keys.publicKey,
    privateKey: ctx.keys.privateKey,
    payTo: ctx.config.payTo,
    agentId: ctx.config.agentId,
    keyId: 'demo-merchant',
    store: ctx.store,
    replayPolicy: 'refuse',
    attachReceipt: false,
    verifyPayment: createVerifyPayment({
      config: ctx.config,
      store: ctx.store,
      fetchImpl: ctx.fetchImpl,
      requirements,
    }),
  });

  const nodeRes = createNodeRes();
  const originalEnd = nodeRes.end.bind(nodeRes);
  nodeRes.end = (payload) => {
    if (nodeReq.sycee?.paymentResponse && !nodeRes.getHeader('payment-response')) {
      writePaymentResponse(nodeRes, nodeReq.sycee.paymentResponse);
    }
    if (nodeRes.statusCode === 402 && !nodeRes.getHeader('payment-required')) {
      nodeRes.setHeader('payment-required', encodeJsonHeader(paymentRequired(ctx.config, resourceUrl)));
    }
    return originalEnd(payload);
  };

  const envelope = await gates.guard(async (req, res) => {
    const block = req.sycee?.block;
    if (!block) return { status: 502, body: { error: 'block_unavailable' } };
    if (req.sycee?.paymentResponse) {
      writePaymentResponse(res, req.sycee.paymentResponse);
    }
    return { status: 200, body: block };
  })(nodeReq, nodeRes);

  const tally = gates.tally();
  ctx.merchant.lastTally = tally;
  await persistAttempts(ctx, gates.ledger(), nodeReq, envelope);
  if (envelope?.vsr && nodeRes.statusCode === 200) {
    await recordAnchor(ctx, envelope);
  }
  return toResponse(nodeRes);
}

async function recordAnchor(ctx, envelope) {
  try {
    const anchor = await anchorSignedReceipt({
      envelope,
      near: ctx.near,
      anchorImpl: ctx.anchorImpl,
    });
    const proofHash = envelope.vsr?.payment?.proof_hash;
    if (anchor && typeof proofHash === 'string') await ctx.store.setAnchor(proofHash, anchor);
  } catch {
    console.error('anchor_record_failed');
  }
}

async function persistAttempts(ctx, rows, nodeReq, envelope) {
  const traffic = trafficClass(nodeReq.headers);
  for (const row of rows) {
    const proofHash = typeof row.proof_hash === 'string' ? row.proof_hash : envelope?.vsr?.payment?.proof_hash;
    if (!/^sha256:[0-9a-f]{64}$/.test(String(proofHash ?? ''))) continue;
    const current = await ctx.store.get(proofHash);
    const settlement = publicSettlement(row, envelope);
    const delivery = row.decision === 'accepted'
      ? (envelope?.vsr?.delivery?.status ?? 'failed')
      : 'none';
    await ctx.store.addAttempt({
      proof_hash: proofHash,
      redeem_count: current?.count ?? envelope?.vsr?.payment?.redeem_count ?? 1,
      decision: row.decision === 'accepted' ? 'accepted' : 'refused',
      reason: row.reason ?? null,
      settlement,
      delivery,
      traffic,
      at: row.observed_at,
      receipt: row.decision === 'accepted' ? envelope ?? null : null,
      trade_no: row.decision === 'accepted' && /^0x[0-9a-fA-F]{64}$/.test(nodeReq.sycee?.tx ?? '')
        ? nodeReq.sycee.tx
        : null,
    });
  }
}

function publicSettlement(row, envelope) {
  if (row.decision === 'accepted' && envelope?.vsr?.payment?.settlement_status) {
    const status = envelope.vsr.payment.settlement_status;
    if (status === 'settled' || status === 'in_flight' || status === 'absent') return status;
  }
  if (row.settlement === 'settled') return 'settled';
  if (row.settlement === 'pending' || row.settlement === 'unknown') return 'in_flight';
  return 'absent';
}

async function agentReceipt(request, ctx) {
  const blocked = blocking(ctx);
  if (blocked.some((code) => code.startsWith('signing_key'))) {
    return json(503, { error: blocked[0], problems: blocked });
  }
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return json(415, { error: 'json_required' });

  const limit = await ctx.store.rateLimit(`receipt:${clientIp(request)}`, ctx.config.rateLimitPerMinute, 60_000);
  if (!limit.allowed) return json(429, { error: 'rate_limited' }, { 'retry-after': '60' });

  const text = await request.text();
  if (text.length > 32_768) return json(413, { error: 'too_large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'bad_json' });
  }
  if (hasRawCredential(body)) return json(400, { error: 'raw_proof_refused' });

  const envelope = body?.receipt && typeof body.receipt === 'object' ? body.receipt : body;
  const verified = verifyVSR(envelope);
  if (!verified.valid) return json(400, { error: 'invalid_receipt' });
  if (envelope?.vsr?.signer?.role !== 'agent') return json(400, { error: 'agent_signature_required' });
  const consumed = envelope.vsr.result?.consumed;
  if (consumed !== 'yes' && consumed !== 'no' && consumed !== 'unknown') {
    return json(400, { error: 'invalid_receipt' });
  }
  const proofHash = envelope.vsr.payment?.proof_hash;
  if (!/^sha256:[0-9a-f]{64}$/.test(String(proofHash ?? ''))) return json(400, { error: 'invalid_receipt' });

  const merchantReceipt = await ctx.store.merchantReceipt(proofHash);
  if (!merchantReceipt) return json(409, { error: 'no_merchant_receipt' });
  const link = linkReceipts(merchantReceipt, envelope);
  if (!link.complete) return json(409, { error: 'link_failed' });

  const existing = await ctx.store.agentReceipt(proofHash);
  if (existing) {
    if (existing.receipt?.signature === envelope.signature && existing.consumed === consumed) {
      return json(200, { linked: true, duplicate: true, consumed, completeness: 'bilateral' });
    }
    return json(409, { error: 'agent_receipt_exists' });
  }

  const agentId = envelope.vsr.signer?.agent_id ?? '';
  await ctx.store.addAgentReceipt({
    proof_hash: proofHash,
    consumed,
    agent_id: typeof agentId === 'string' ? agentId.slice(0, 200) : null,
    traffic: trafficClass(request.headers, agentId),
    at: new Date().toISOString(),
    receipt: envelope,
    resource_id: envelope.vsr.resource_id,
  });
  return json(200, {
    linked: true,
    consumed,
    completeness: link.completeness,
    proof_hash: truncateProofHash(proofHash),
  });
}

function hasRawCredential(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') {
    if (value.length > 8_000) return true;
    if (/^0x[0-9a-fA-F]{64,}$/.test(value)) return true;
    if (value.includes('PAYMENT-SIGNATURE') || value.includes('paymentPayload')) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => hasRawCredential(item, depth + 1));
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (BANNED_KEYS.has(key.toLowerCase())) return true;
      if (hasRawCredential(item, depth + 1)) return true;
    }
  }
  return false;
}

async function receipts(ctx) {
  const rows = await ctx.store.listReceipts(20);
  const listed = [];
  for (const row of rows) {
    try {
      const envelope = { vsr: row.receipt.vsr, signature: row.receipt.signature };
      listed.push({
        ...envelope,
        at: row.at,
        decision: row.decision,
        settlement: row.settlement,
        delivery: row.delivery,
        traffic: row.traffic,
        redeem_count: row.redeem_count,
        receipt_hash: receiptHash(envelope),
        anchor: row.anchor ?? null,
      });
    } catch {
      continue;
    }
  }
  return json(200, {
    service: 'sycee-demo-merchant',
    statement: 'Signed merchant receipts only. No scoring, no custody, no fund movement. Raw payment proofs are not included.',
    config: {
      network: ctx.config.network,
      pay_to: ctx.config.payTo || null,
      merchant_agent_id: ctx.config.agentId,
    },
    near: ctx.near.public,
    receipts: listed,
  });
}

async function verifyReceipt(request, ctx) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return json(415, { error: 'json_required' });
  const limit = await ctx.store.rateLimit(`verify:${clientIp(request)}`, ctx.config.rateLimitPerMinute, 60_000);
  if (!limit.allowed) return json(429, { error: 'rate_limited' }, { 'retry-after': '60' });
  const text = await request.text();
  if (text.length > 32_768) return json(413, { error: 'too_large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'bad_json' });
  }
  if (hasRawCredential(body)) return json(400, { error: 'raw_proof_refused' });
  const envelope = body?.receipt && typeof body.receipt === 'object' ? body.receipt : body;
  let digest;
  try {
    digest = digestHex(receiptHash(envelope));
  } catch {
    return json(400, { error: 'invalid_receipt' });
  }

  let record = null;
  let chain = 'skipped';
  if (ctx.near.lookup) {
    try {
      record = await lookupAnchor(ctx.fetchImpl, {
        rpcUrl: ctx.near.public.rpc_url || ctx.near.rpcUrl,
        contractId: ctx.near.contractId,
        digest,
      });
      chain = record ? 'found' : 'missing';
    } catch {
      chain = 'error';
    }
  }
  let judged;
  try {
    // A fake matching record keeps the signature check and suppresses
    // "not anchored" when this process did not actually ask NEAR.
    const compared = chain === 'found' || chain === 'missing' ? record : { receipt_hash: digest };
    judged = judgeReceipt(envelope, compared);
  } catch {
    return json(400, { error: 'invalid_receipt' });
  }
  if (chain === 'error') {
    judged.record = null;
    judged.errors = [...judged.errors, 'chain_lookup_failed'];
    judged.ok = false;
  } else if (chain === 'skipped') {
    judged.record = null;
    judged.errors = [...judged.errors, 'chain_skipped'];
    judged.ok = false;
  }
  const signatureOk = !judged.errors.some((item) => item.startsWith('vsr:'));
  return json(200, {
    ok: judged.ok,
    signature_ok: signatureOk,
    anchored: chain === 'found' && judged.ok,
    errors: judged.errors,
    hash: judged.hash,
    digest: judged.digest,
    level: judged.level,
    chain,
    contract: ctx.near.contractId,
    record: judged.record,
    verifier: 'verify.mjs',
  });
}

async function evidencePanel() {
  try {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(new URL('../public/evidence.html', import.meta.url), 'utf8');
    return new Response(html, {
      status: 200,
      headers: common({ 'content-type': 'text/html; charset=utf-8' }),
    });
  } catch {
    return json(503, { error: 'panel_unavailable' });
  }
}

function meta(ctx) {
  return {
    publicKey: ctx.publicKey,
    storeKind: ctx.storeKind,
    problems: blocking(ctx),
    near: ctx.near.public,
  };
}

function blocking(ctx) {
  return ctx.problems.filter((code) => BLOCKING.has(code));
}

function toNodeReq(request) {
  const url = new URL(request.url);
  /** @type {Record<string, string>} */
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    query: Object.fromEntries(url.searchParams),
  };
}

function createNodeRes() {
  /** @type {Record<string, string>} */
  const headers = {};
  let statusCode = 200;
  let body = '';
  let ended = false;
  return {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    get writableEnded() {
      return ended;
    },
    end(payload) {
      body = payload == null ? '' : String(payload);
      ended = true;
    },
    snapshot() {
      return { statusCode, headers: { ...headers }, body };
    },
  };
}

function toResponse(nodeRes) {
  const snap = nodeRes.snapshot();
  return new Response(snap.body, { status: snap.statusCode, headers: common(snap.headers) });
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: common({ 'content-type': 'application/json; charset=utf-8', ...extra }),
  });
}

function empty(status) {
  return new Response(null, { status, headers: common() });
}

function common(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X-Gates-Receipt, X-Gates-Redeem-Count, X-Gates-Proof-Hash, X-Gates-Settlement-Status, X-Gates-Refusal, X-Gates-Refusal-Reason',
    'access-control-allow-headers': 'PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, X-Sycee-Traffic, X-Sycee-Agent-Id',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    vary: 'Origin',
    ...extra,
  };
}

