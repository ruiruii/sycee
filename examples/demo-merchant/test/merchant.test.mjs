import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { buildVSR, generateKeyPair, signVSR, verifyVSR } from '@sycee/core';
import { createSpend, linkReceipts } from '@sycee/agent-sdk';
import { MIGRATION_SQL } from '../src/schema.mjs';
import { d1Store, memoryStore } from '../src/store.mjs';
import { createMerchant } from '../src/merchant.mjs';
import { decodeJsonHeader } from '../src/x402.mjs';
import { truncateProofHash } from '../src/evidence.mjs';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ORIGIN = 'http://merchant.test';
const TIP = `${ORIGIN}/v1/base/tip`;

function nonce() {
  return `0x${randomBytes(32).toString('hex')}`;
}

function paymentHeader({
  nonce: nonceValue = nonce(),
  to = PAY_TO,
  value = '1000',
  asset = ASSET,
  network = 'eip155:84532',
  signature = `0x${randomBytes(65).toString('hex')}`,
} = {}) {
  const payload = {
    x402Version: 2,
    resource: { url: TIP, description: 'Latest Base block number, timestamp, and base fee', mimeType: 'application/json' },
    accepted: {
      scheme: 'exact',
      network,
      amount: value,
      asset,
      payTo: to,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
    payload: {
      signature,
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to,
        value,
        validAfter: '0',
        validBefore: '9999999999',
        nonce: nonceValue,
      },
    },
  };
  const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return { header, payload, nonce: nonceValue, signature };
}

async function boot(overrides = {}, hooks = {}) {
  const keys = overrides.keys ?? generateKeyPair();
  const calls = [];
  const env = {
    PAY_TO,
    NETWORK: 'eip155:84532',
    SYCEE_SIGNING_KEY: keys.privateKey,
    RATE_LIMIT_PER_MINUTE: '1000',
    ...overrides,
  };
  delete env.keys;
  if (!env.fetchImpl) {
    env.fetchImpl = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init?.method, body });
      if (String(url).endsWith('/verify')) {
        const verdict = hooks.verify ? await hooks.verify(body, calls) : {
          isValid: true,
          payer: '0x1111111111111111111111111111111111111111',
        };
        return Response.json(verdict, { status: verdict.status ?? 200 });
      }
      if (String(url).endsWith('/settle')) {
        const verdict = hooks.settle ? await hooks.settle(body, calls) : {
          success: true,
          transaction: `0x${'cd'.repeat(32)}`,
          network: 'eip155:84532',
          payer: '0x1111111111111111111111111111111111111111',
        };
        return Response.json(verdict);
      }
      const result = hooks.rpc ? await hooks.rpc(body, calls) : {
        number: '0x10',
        timestamp: '0x67400000',
        baseFeePerGas: '0x3b9aca00',
      };
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    };
  }
  const merchant = await createMerchant(env);
  return { merchant, calls, keys, env };
}

async function get(merchant, path, headers = {}) {
  return merchant.fetch(new Request(`${ORIGIN}${path}`, { headers }));
}

function merchantEnvelope(response) {
  const raw = response.headers.get('x-gates-receipt');
  assert.ok(raw, 'missing x-gates-receipt');
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
}

function agentEnvelope(merchantEnv, agentKeys, consumed, agentId = 'external:agent') {
  const vsr = buildVSR({
    protocol: 'x402',
    resourceId: merchantEnv.vsr.resource_id,
    proofHash: merchantEnv.vsr.payment.proof_hash,
    redeemCount: merchantEnv.vsr.payment.redeem_count,
    settlementStatus: merchantEnv.vsr.payment.settlement_status,
    deliveryStatus: merchantEnv.vsr.delivery.status,
    consumed,
    consumedBy: consumed === 'yes' ? ['task_test'] : undefined,
    requestFingerprint: merchantEnv.vsr.request_fingerprint,
    amount: merchantEnv.vsr.amount,
    publicKey: agentKeys.publicKey,
    agentId,
    role: 'agent',
    completeness: 'bilateral',
  });
  return signVSR(vsr, agentKeys.privateKey);
}

test('the migration file matches the schema module', () => {
  const file = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
  assert.equal(file, MIGRATION_SQL);
  assert.match(file, /CREATE TABLE IF NOT EXISTS redemptions/);
  assert.match(file, /CREATE TABLE IF NOT EXISTS attempts/);
  assert.match(file, /CREATE TABLE IF NOT EXISTS agent_receipts/);
  const ddl = file.replace(/--.*$/gm, '');
  assert.doesNotMatch(ddl, /payment_payload|raw_proof|\bauthorization\b/i);
});

test('an unpaid GET is a standard x402 402, not a gates_spec challenge', async () => {
  const { merchant, calls } = await boot();
  const res = await get(merchant, '/v1/base/tip?rpc=https://evil.example&url=https://evil.example');
  assert.equal(res.status, 402);
  assert.equal(calls.length, 0, 'an unpaid challenge must not call the facilitator or any RPC');
  const header = res.headers.get('payment-required');
  assert.ok(header);
  assert.match(header, /^[A-Za-z0-9+/]+=*$/);
  const required = decodeJsonHeader(header);
  assert.equal(required.x402Version, 2);
  assert.equal(required.resource.url, TIP);
  assert.equal(required.accepts.length, 1);
  const accepts = required.accepts[0];
  assert.equal(accepts.scheme, 'exact');
  assert.equal(accepts.network, 'eip155:84532');
  assert.equal(accepts.amount, '1000');
  assert.equal(accepts.asset, ASSET);
  assert.equal(accepts.payTo, PAY_TO);
  assert.equal(accepts.extra.name, 'USDC');
  assert.equal(accepts.extra.version, '2');
  const body = await res.json();
  assert.equal(body.x402Version, 2);
  assert.equal(body.accepts[0].amount, '1000');
  assert.equal(JSON.stringify(body).includes('gates_spec'), false);
  assert.equal(JSON.stringify(required).includes('gates_spec'), false);
  assert.equal(res.headers.get('x-gates-receipt'), null);
});

test('a paid request verifies, settles, and returns the block plus a merchant receipt', async () => {
  const { merchant, calls } = await boot();
  const paid = paymentHeader();
  const res = await get(merchant, '/v1/base/tip?rpc=https://evil.example', { 'payment-signature': paid.header });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.block_number, 16);
  assert.equal(body.base_fee_per_gas, '1000000000');
  assert.equal(body.timestamp, new Date(0x67400000 * 1000).toISOString());
  assert.equal(body.network, 'eip155:84532');
  assert.equal(res.headers.get('x-gates-redeem-count'), '1');
  assert.match(res.headers.get('x-gates-proof-hash'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(res.headers.get('x-gates-settlement-status'), 'settled');

  const envelope = merchantEnvelope(res);
  const verdict = verifyVSR(envelope);
  assert.equal(verdict.valid, true);
  assert.equal(envelope.vsr.result.consumed, 'unknown');
  assert.equal(envelope.vsr.signer.role, 'merchant');
  assert.equal(envelope.vsr.payment.redeem_count, 1);
  assert.equal(envelope.vsr.completeness, 'unilateral_merchant');

  const settled = decodeJsonHeader(res.headers.get('payment-response'));
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, `0x${'cd'.repeat(32)}`);

  assert.equal(calls[0].url, 'https://x402.org/facilitator/verify');
  assert.equal(calls[1].body.method, 'eth_getBlockByNumber');
  assert.deepEqual(calls[1].body.params, ['latest', false]);
  assert.equal(calls[1].url, 'https://sepolia.base.org');
  assert.equal(calls[2].url, 'https://x402.org/facilitator/settle');
  assert.equal(calls[2].body.paymentRequirements.amount, '1000');
  assert.equal(calls[2].body.paymentRequirements.network, 'eip155:84532');
  assert.equal(calls[2].body.paymentRequirements.payTo, PAY_TO);
  assert.equal(calls.some((call) => call.url.includes('evil.example')), false);
  assert.equal(merchant.lastTally.accepted, 1);
  assert.equal(merchant.lastTally.refused, 0);
});

test('a replay is refused and redeem_count becomes 2, including the refusal', async () => {
  const { merchant } = await boot();
  const paid = paymentHeader();
  const first = await get(merchant, '/v1/base/tip', {
    'payment-signature': paid.header,
    'x-sycee-traffic': 'self-test',
  });
  assert.equal(first.status, 200);
  const proofHash = first.headers.get('x-gates-proof-hash');

  const replay = await get(merchant, '/v1/base/tip', {
    'payment-signature': paid.header,
    'x-sycee-traffic': 'self-test',
  });
  assert.equal(replay.status, 402);
  const replayBody = await replay.json();
  assert.equal(replayBody.reason, 'duplicate_payment');
  assert.equal(replay.headers.get('x-gates-proof-hash'), proofHash);
  assert.ok(replay.headers.get('payment-required'));
  const responseHeader = decodeJsonHeader(replay.headers.get('payment-response'));
  assert.equal(responseHeader.success, false);
  assert.equal(responseHeader.errorReason, 'duplicate_payment');

  const evidence = await (await get(merchant, '/evidence.json')).json();
  assert.equal(evidence.decisions.accepted, 1);
  assert.equal(evidence.decisions.refused, 1);
  assert.equal(evidence.redeem_count.eq1, 0);
  assert.equal(evidence.redeem_count.gt1, 1);
  assert.equal(evidence.redeem_count.max, 2);
  assert.equal(evidence.settlement.settled, 1);
  assert.equal(evidence.settlement.absent, 1);
  assert.equal(evidence.traffic.self_test, 2);
  assert.equal(evidence.traffic.external, 0);
  assert.equal(evidence.recent[0].redeem_count, 2);
  assert.equal(evidence.recent[0].decision, 'refused');
  assert.equal(evidence.recent[0].delivery, 'none');
  assert.equal(evidence.recent[0].proof_hash, truncateProofHash(proofHash));
  assert.notEqual(evidence.recent[0].proof_hash, proofHash);
  assert.match(evidence.redeem_count.note, /refused replays/);
});

test('the raw payment is sent to the facilitator and never stored or echoed', async () => {
  const { merchant, calls } = await boot();
  const paid = paymentHeader();
  const res = await get(merchant, '/v1/base/tip', { 'payment-signature': paid.header });
  assert.equal(res.status, 200);
  const replay = await get(merchant, '/v1/base/tip', { 'payment-signature': paid.header });
  const replayText = await replay.text();
  const evidenceRes = await get(merchant, '/evidence.json');
  const evidenceText = await evidenceRes.text();
  const page = await (await get(merchant, '/')).text();
  const dumped = JSON.stringify(await merchant.store.dump());

  assert.equal(calls.some((call) => JSON.stringify(call.body).includes(paid.nonce)), true);
  for (const blob of [await res.text(), replayText, evidenceText, page, dumped, JSON.stringify([...res.headers])]) {
    assert.equal(blob.includes(paid.nonce), false, 'nonce leaked');
    assert.equal(blob.includes(paid.signature), false, 'signature leaked');
    assert.equal(blob.includes(paid.header), false, 'payment header leaked');
  }
});

test('a mismatched recipient is refused before settle', async () => {
  const { merchant, calls } = await boot();
  const paid = paymentHeader({ to: '0x3333333333333333333333333333333333333333' });
  const res = await get(merchant, '/v1/base/tip', { 'payment-signature': paid.header });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.reason, 'wrong_recipient');
  assert.equal(calls.some((call) => call.url.endsWith('/settle')), false);
  assert.equal(calls.some((call) => call.url.endsWith('/verify')), false);
});

test('verify failure does not settle or fetch the block', async () => {
  const { merchant, calls } = await boot({}, {
    verify: () => ({ isValid: false, invalidReason: 'insufficient_funds' }),
  });
  const res = await get(merchant, '/v1/base/tip', { 'payment-signature': paymentHeader().header });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).reason, 'insufficient_funds');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/verify'), true);
});

test('a failed block read does not settle', async () => {
  const { merchant, calls } = await boot({}, { rpc: () => null });
  const res = await get(merchant, '/v1/base/tip', { 'payment-signature': paymentHeader().header });
  assert.equal(res.status, 402);
  assert.equal(calls.some((call) => call.url.endsWith('/settle')), false);
});

test('consumed split stays hidden under k=10, and unknown is not yes', async () => {
  const { merchant, keys } = await boot();
  const agent = generateKeyPair();
  const headers = { 'content-type': 'application/json' };

  for (let i = 0; i < 9; i++) {
    const res = await get(merchant, '/v1/base/tip', { 'payment-signature': paymentHeader().header });
    assert.equal(res.status, 200);
    const posted = await merchant.fetch(new Request(`${ORIGIN}/v1/agent-receipt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ receipt: agentEnvelope(merchantEnvelope(res), agent, 'yes') }),
    }));
    assert.equal(posted.status, 200, await posted.clone().text());
  }

  const hidden = await (await get(merchant, '/evidence.json')).json();
  assert.equal(hidden.consumed.published, false);
  assert.equal(hidden.consumed.label, 'not published (k<10)');
  assert.equal(hidden.consumed.k, 9);
  assert.equal('yes' in hidden.consumed, false);
  assert.equal('no' in hidden.consumed, false);
  assert.equal('unknown' in hidden.consumed, false);

  const merchantClaim = signVSR(buildVSR({
    protocol: 'x402',
    resourceId: 'base.tip.v1',
    proofHash: `sha256:${'ab'.repeat(32)}`,
    redeemCount: 1,
    consumed: 'yes',
    publicKey: keys.publicKey,
    role: 'merchant',
  }), keys.privateKey);
  const rejected = await merchant.fetch(new Request(`${ORIGIN}/v1/agent-receipt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ receipt: merchantClaim }),
  }));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'agent_signature_required');

  const last = await get(merchant, '/v1/base/tip', { 'payment-signature': paymentHeader().header });
  const unknownPosted = await merchant.fetch(new Request(`${ORIGIN}/v1/agent-receipt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ receipt: agentEnvelope(merchantEnvelope(last), agent, 'unknown') }),
  }));
  assert.equal(unknownPosted.status, 200);

  const shown = await (await get(merchant, '/evidence.json')).json();
  assert.equal(shown.consumed.published, true);
  assert.equal(shown.consumed.k, 10);
  assert.equal(shown.consumed.yes, 9);
  assert.equal(shown.consumed.unknown, 1);
  assert.equal(shown.consumed.no, 0);
  assert.equal(shown.consumed.yes + shown.consumed.no + shown.consumed.unknown, shown.consumed.k);
});

test('merchant receipts alone never publish a consumed yes count', async () => {
  const { merchant } = await boot();
  for (let i = 0; i < 12; i++) {
    const res = await get(merchant, '/v1/base/tip', { 'payment-signature': paymentHeader().header });
    assert.equal(res.status, 200);
    assert.equal(merchantEnvelope(res).vsr.result.consumed, 'unknown');
  }
  const evidence = await (await get(merchant, '/evidence.json')).json();
  assert.equal(evidence.decisions.accepted, 12);
  assert.equal(evidence.consumed.published, false);
  assert.equal(evidence.consumed.k, 0);
  assert.equal(evidence.consumed.label, 'not published (k<10)');
});

test('self-test and external traffic are counted apart', async () => {
  const { merchant } = await boot();
  const external = await get(merchant, '/v1/base/tip', { 'payment-signature': paymentHeader().header });
  const labeled = await get(merchant, '/v1/base/tip', {
    'payment-signature': paymentHeader().header,
    'x-sycee-agent-id': 'sycee:self-test',
  });
  assert.equal(external.status, 200);
  assert.equal(labeled.status, 200);
  const evidence = await (await get(merchant, '/evidence.json')).json();
  assert.equal(evidence.traffic.external, 1);
  assert.equal(evidence.traffic.self_test, 1);
  assert.match(evidence.traffic.note, /not an authentication/);
});

test('createSpend links consumed=yes and consumed=no, and a raw proof post is refused', async () => {
  const { merchant } = await boot();
  const agent = generateKeyPair();
  let captured = null;
  const spend = createSpend({
    agentId: 'sycee:self-test',
    publicKey: agent.publicKey,
    privateKey: agent.privateKey,
    fetchImpl: (url, init) => merchant.fetch(new Request(url, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
    })),
    pay: async () => {
      const paid = paymentHeader();
      captured = paid;
      return paid.header;
    },
  });
  const headers = { 'x-sycee-traffic': 'self-test' };
  const yesRes = await spend.fetch(TIP, { headers });
  assert.equal(yesRes.status, 200);
  const yesReceipt = yesRes.gates.consumedBy('task_self_test_yes');
  const merchantYes = merchantEnvelope(yesRes);
  assert.equal(linkReceipts(merchantYes, yesReceipt).complete, true);

  const postedYes = await merchant.fetch(new Request(`${ORIGIN}/v1/agent-receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sycee-traffic': 'self-test' },
    body: JSON.stringify({ receipt: yesReceipt, authorization: { nonce: captured.nonce } }),
  }));
  assert.equal(postedYes.status, 400);
  assert.equal((await postedYes.json()).error, 'raw_proof_refused');

  const cleanYes = await merchant.fetch(new Request(`${ORIGIN}/v1/agent-receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sycee-traffic': 'self-test' },
    body: JSON.stringify({ receipt: yesReceipt }),
  }));
  assert.equal(cleanYes.status, 200);
  assert.equal((await cleanYes.json()).consumed, 'yes');

  const noRes = await spend.fetch(TIP, { headers });
  assert.equal(noRes.status, 200);
  const noReceipt = noRes.gates.notConsumed();
  assert.equal(noReceipt.vsr.result.consumed, 'no');
  const postedNo = await merchant.fetch(new Request(`${ORIGIN}/v1/agent-receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sycee-traffic': 'self-test' },
    body: JSON.stringify({ receipt: noReceipt }),
  }));
  assert.equal(postedNo.status, 200);

  const dumped = JSON.stringify(await merchant.store.dump());
  assert.equal(dumped.includes(captured.nonce), false);
  const evidence = await (await get(merchant, '/evidence.json')).json();
  assert.equal(evidence.consumed.published, false);
  assert.equal(evidence.consumed.k, 2);
  assert.equal(evidence.traffic.self_test, 2);
});

test('public pages name the demo and never carry the signing key', async () => {
  const { merchant, keys } = await boot();
  const page = await (await get(merchant, '/')).text();
  assert.match(page, /SYCEE team's own first-party demo merchant/);
  assert.match(page, /No scoring, no custody, no fund movement/);
  assert.match(page, /not published \(k&lt;10\)|not published \(k<10\)/);
  assert.match(page, new RegExp(PAY_TO));
  assert.match(page, /eip155:84532/);
  assert.match(page, /x402\.org\/facilitator/);
  assert.match(page, /ed25519:/);
  assert.equal(page.includes(keys.privateKey), false);
  assert.equal(page.includes('gates_spec'), false);

  const known = await (await get(merchant, '/.well-known/sycee.json')).json();
  assert.equal(known.public_key, merchant.publicKey);
  assert.equal(known.price.atomic, '1000');
  assert.equal(known.network, 'eip155:84532');
  assert.equal(JSON.stringify(known).includes(keys.privateKey), false);
  assert.equal(JSON.stringify(known).includes('ed25519-priv:'), false);

  const health = await (await get(merchant, '/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.configured, true);
  assert.equal(health.mainnet, false);
});

test('mainnet, a missing payTo, and a signing key that is the payee are not served', async () => {
  const mainnet = await boot({ NETWORK: 'eip155:8453', MAINNET: 'false' });
  assert.equal((await get(mainnet.merchant, '/v1/base/tip')).status, 503);
  assert.equal((await (await get(mainnet.merchant, '/v1/base/tip')).json()).error, 'mainnet_disabled');

  const flagged = await boot({
    NETWORK: 'eip155:8453',
    MAINNET: 'true',
    ASSET: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    ASSET_NAME: 'USD Coin',
  });
  assert.equal((await (await get(flagged.merchant, '/v1/base/tip')).json()).error, 'testnet_facilitator');

  const unpaid = await boot({ PAY_TO: '' });
  assert.equal((await (await get(unpaid.merchant, '/v1/base/tip')).json()).error, 'pay_to_missing');

  const keys = generateKeyPair();
  const collided = await boot({ keys, PAY_TO: keys.publicKey });
  const collidedBody = await (await get(collided.merchant, '/v1/base/tip')).json();
  assert.equal(collidedBody.error, 'signing_key_is_payee');
});

test('rate limit refuses the third call without calling the facilitator', async () => {
  const { merchant, calls } = await boot({ RATE_LIMIT_PER_MINUTE: '2' });
  assert.equal((await get(merchant, '/v1/base/tip', { 'cf-connecting-ip': '203.0.113.5' })).status, 402);
  assert.equal((await get(merchant, '/v1/base/tip', { 'cf-connecting-ip': '203.0.113.5' })).status, 402);
  const limited = await get(merchant, '/v1/base/tip', { 'cf-connecting-ip': '203.0.113.5' });
  assert.equal(limited.status, 429);
  assert.equal(calls.length, 0);
  const other = await get(merchant, '/v1/base/tip', { 'cf-connecting-ip': '203.0.113.9' });
  assert.equal(other.status, 402);
});

test('sqlite store matches the memory store', async (t) => {
  let sqliteAsD1;
  try {
    ({ sqliteAsD1 } = await import('../src/node-store.mjs'));
  } catch (err) {
    t.skip(String(err && err.message));
    return;
  }
  let sqlDb;
  try {
    sqlDb = sqliteAsD1(':memory:');
  } catch (err) {
    t.skip(String(err && err.message));
    return;
  }
  const mem = memoryStore();
  const sql = d1Store(sqlDb);
  const hash = `sha256:${'ab'.repeat(32)}`;
  await mem.incr(hash, 'base.tip.v1');
  await sql.incr(hash, 'base.tip.v1');
  await mem.incr(hash, 'base.tip.v1');
  await sql.incr(hash, 'base.tip.v1');
  const accepted = {
    proof_hash: hash,
    redeem_count: 1,
    decision: 'accepted',
    reason: null,
    settlement: 'settled',
    delivery: 'delivered',
    traffic: 'external',
    at: '2026-01-01T00:00:00.000Z',
    receipt: { vsr: { payment: { proof_hash: hash } }, signature: 'sig' },
    trade_no: `0x${'cd'.repeat(32)}`,
  };
  const refused = {
    ...accepted,
    redeem_count: 2,
    decision: 'refused',
    reason: 'duplicate_payment',
    settlement: 'absent',
    delivery: 'none',
    receipt: null,
    trade_no: null,
  };
  await mem.addAttempt(accepted);
  await sql.addAttempt(accepted);
  await mem.addAttempt(refused);
  await sql.addAttempt(refused);
  await mem.addAgentReceipt({
    proof_hash: hash,
    consumed: 'yes',
    agent_id: 'sycee:self-test',
    traffic: 'self-test',
    at: '2026-01-01T00:00:01.000Z',
    receipt: { vsr: { result: { consumed: 'yes' } }, signature: 'a' },
    resource_id: 'base.tip.v1',
  });
  await sql.addAgentReceipt({
    proof_hash: hash,
    consumed: 'yes',
    agent_id: 'sycee:self-test',
    traffic: 'self-test',
    at: '2026-01-01T00:00:01.000Z',
    receipt: { vsr: { result: { consumed: 'yes' } }, signature: 'a' },
    resource_id: 'base.tip.v1',
  });
  assert.deepEqual(await sql.stats(), await mem.stats());
  const loaded = await sql.merchantReceipt(hash);
  assert.equal(loaded.vsr.payment.proof_hash, hash);
  assert.equal((await mem.rateLimit('tip:a', 1, 60_000)).allowed, true);
  assert.equal((await sql.rateLimit('tip:a', 1, 60_000)).allowed, true);
  assert.equal((await mem.rateLimit('tip:a', 1, 60_000)).allowed, false);
  assert.equal((await sql.rateLimit('tip:a', 1, 60_000)).allowed, false);
});
