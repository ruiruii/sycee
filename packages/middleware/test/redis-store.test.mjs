import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redisStore } from '../src/index.mjs';

/**
 * A minimal in-memory stand-in for a Redis client. It records every TTL it was
 * asked to set, so a test can assert whether a key was made to expire.
 */
function fakeRedis() {
  const data = new Map();
  const ttlSet = new Map(); // key -> seconds
  return {
    data,
    ttlSet,
    async incr(key) {
      const n = Number(data.get(key) ?? 0) + 1;
      data.set(key, String(n));
      return n;
    },
    async sadd(key, value) {
      const set = data.get(key) instanceof Set ? data.get(key) : new Set();
      set.add(value);
      data.set(key, set);
      return 1;
    },
    async smembers(key) {
      return data.get(key) instanceof Set ? [...data.get(key)] : [];
    },
    async get(key) {
      const v = data.get(key);
      if (v instanceof Set) return null;
      return v ?? null;
    },
    async set(key, value, _ex, seconds) {
      data.set(key, String(value));
      if (seconds !== undefined) ttlSet.set(key, seconds);
      return 'OK';
    },
    async expire(key, seconds) {
      ttlSet.set(key, seconds);
      return 1;
    },
  };
}

test('counters are persistent by default: no TTL is set on the count key', async () => {
  const client = fakeRedis();
  const store = redisStore(client);

  const first = await store.incr('sha256:proof', 'search.v1');
  assert.equal(first.count, 1);
  assert.equal(client.ttlSet.has('gates:proof:sha256:proof'), false, 'the count must not expire by default');
  assert.equal(client.ttlSet.has('gates:proof:sha256:proof:resources'), false);
  assert.equal(client.ttlSet.has('gates:proof:sha256:proof:first'), false, 'firstSeen must survive too');
});

test('a counter is not reset to 1 when a long-lived proof is presented again', async () => {
  const client = fakeRedis();
  const store = redisStore(client);

  await store.incr('sha256:proof', 'search.v1');
  await store.incr('sha256:proof', 'search.v1');
  const third = await store.incr('sha256:proof', 'search.v1');
  assert.equal(third.count, 3, 'a replay must read as the third presentation, not a fresh first');
});

test('settlement memory is persistent by default, so a settled replay is not read as a purchase', async () => {
  const client = fakeRedis();
  const store = redisStore(client);

  await store.incr('sha256:proof', 'search.v1');
  await store.recordSettlement('sha256:proof', 'settled');
  assert.equal(client.ttlSet.has('gates:proof:sha256:proof:settlement'), false, 'settlement must not expire by default');

  const seen = await store.get('sha256:proof');
  assert.equal(seen.settlement, 'settled');
});

test('ttlDays is an explicit opt-in: a bounded deployment still expires its keys', async () => {
  const client = fakeRedis();
  const store = redisStore(client, { ttlDays: 90 });

  await store.incr('sha256:proof', 'search.v1');
  await store.recordSettlement('sha256:proof', 'absent');

  const expected = 90 * 86400;
  assert.equal(client.ttlSet.get('gates:proof:sha256:proof'), expected, 'the count expires when asked to');
  assert.equal(client.ttlSet.get('gates:proof:sha256:proof:resources'), expected);
  assert.equal(client.ttlSet.get('gates:proof:sha256:proof:settlement'), expected);
});

test('a zero or negative ttlDays is treated as "no expiry", not "expire immediately"', async () => {
  const client = fakeRedis();
  const store = redisStore(client, { ttlDays: 0 });

  await store.incr('sha256:proof', 'search.v1');
  assert.equal(client.ttlSet.has('gates:proof:sha256:proof'), false, 'a zero ttl must not be sent as an immediate expiry');
});
