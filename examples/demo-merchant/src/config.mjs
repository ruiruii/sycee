/**
 * Deployment configuration. Every value that would change between Base Sepolia
 * and a later mainnet cutover is an environment / wrangler var. Mainnet is
 * not enabled unless MAINNET=true, and the public testnet facilitator is
 * refused in that mode.
 */

import { createPublicKey } from 'node:crypto';
import { generateKeyPair, loadPrivateKey, signingKeyCheck } from '@sycee/core';

export const RESOURCE_PATH = '/v1/base/tip';
export const RESOURCE_ID_DEFAULT = 'base.tip.v1';
export const K_MIN = 10;
export const MAX_PRICE_ATOMIC = 100_000_000n; // $100 of a 6-decimal stablecoin

export const NETWORK_DEFAULTS = {
  'eip155:84532': {
    testnet: true,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    assetName: 'USDC',
    assetVersion: '2',
    rpc: 'https://sepolia.base.org',
  },
  'eip155:8453': {
    testnet: false,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    assetName: 'USD Coin',
    assetVersion: '2',
    rpc: 'https://mainnet.base.org',
  },
};

const MAINNET_NETWORKS = new Set(['eip155:8453', 'eip155:1']);

/**
 * @param {Record<string, unknown>} env
 */
export function readConfig(env = {}) {
  const problems = [];
  const network = str(env.NETWORK) || 'eip155:84532';
  const defaults = NETWORK_DEFAULTS[network] ?? null;
  const mainnetEnabled = str(env.MAINNET) === 'true';
  const facilitatorUrl = (str(env.FACILITATOR_URL) || 'https://x402.org/facilitator').replace(/\/+$/, '');
  const rpcUrl = str(env.RPC_URL) || defaults?.rpc || 'https://sepolia.base.org';
  const asset = str(env.ASSET) || defaults?.asset || '';
  const assetName = str(env.ASSET_NAME) || defaults?.assetName || '';
  const assetVersion = str(env.ASSET_VERSION) || defaults?.assetVersion || '';
  const currency = str(env.CURRENCY) || 'USDC';
  const payTo = str(env.PAY_TO);
  const agentId = str(env.MERCHANT_AGENT_ID) || 'sycee:demo-merchant';
  const resourceId = str(env.RESOURCE_ID) || RESOURCE_ID_DEFAULT;

  const price = resolvePrice(env, problems);

  if (!asset || !/^0x[0-9a-fA-F]{40}$/.test(asset)) problems.push('bad_asset');
  if (!assetName || !assetVersion) problems.push('bad_asset_domain');
  if (payTo && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) problems.push('pay_to_malformed');
  if (!payTo) problems.push('pay_to_missing');

  const facilitator = checkServiceUrl(facilitatorUrl);
  if (!facilitator.ok) problems.push('bad_facilitator_url');
  const rpc = checkServiceUrl(rpcUrl);
  if (!rpc.ok) problems.push('bad_rpc_url');

  if (MAINNET_NETWORKS.has(network) && !mainnetEnabled) problems.push('mainnet_disabled');
  if (mainnetEnabled && facilitator.ok && facilitator.host.endsWith('x402.org')) {
    problems.push('testnet_facilitator');
  }

  const rate = Number(str(env.RATE_LIMIT_PER_MINUTE) || '60');
  const rateLimitPerMinute = Number.isInteger(rate) && rate >= 1 && rate <= 10_000 ? rate : 60;

  const timeout = Number(str(env.MAX_TIMEOUT_SECONDS) || '60');
  const maxTimeoutSeconds = Number.isInteger(timeout) && timeout >= 10 && timeout <= 300 ? timeout : 60;

  return {
    network,
    testnet: defaults ? defaults.testnet : !MAINNET_NETWORKS.has(network),
    mainnetEnabled,
    facilitatorUrl,
    rpcUrl,
    asset,
    assetName,
    assetVersion,
    currency,
    payTo,
    priceAtomic: price.atomic,
    priceDisplay: price.display,
    agentId,
    resourceId,
    rateLimitPerMinute,
    maxTimeoutSeconds,
    problems,
  };
}

/**
 * @param {Record<string, unknown>} env
 */
export function loadMerchantKeys(env = {}) {
  const configured = str(env.SYCEE_SIGNING_KEY);
  if (configured) {
    if (!configured.startsWith('ed25519-priv:')) return { error: 'signing_key_malformed' };
    try {
      const publicKey = publicKeyFromPrivate(configured);
      const advertised = str(env.SYCEE_PUBLIC_KEY);
      if (advertised && advertised !== publicKey) return { error: 'signing_key_mismatch' };
      return { publicKey, privateKey: configured, ephemeral: false };
    } catch {
      return { error: 'signing_key_malformed' };
    }
  }
  if (str(env.SYCEE_EPHEMERAL_KEYS) === '1' || str(env.SYCEE_EPHEMERAL_KEYS) === 'true') {
    const generated = generateKeyPair();
    return { ...generated, ephemeral: true };
  }
  return { error: 'signing_key_missing' };
}

/**
 * @param {string} privateKeyRef `ed25519-priv:<base64url PKCS8>`
 */
export function publicKeyFromPrivate(privateKeyRef) {
  const pub = createPublicKey(loadPrivateKey(privateKeyRef));
  const der = pub.export({ type: 'spki', format: 'der' });
  return `ed25519:${Buffer.from(der).toString('base64url')}`;
}

/**
 * Problems that must stop the paid route. `not_measured` is not one of them:
 * a missing payTo is already `pay_to_missing`.
 *
 * @param {{ publicKey?: string, payTo?: string }} input
 */
export function keyProblems(input) {
  if (!input.publicKey) return [];
  const check = signingKeyCheck({ signingPublicKey: input.publicKey, payTo: input.payTo });
  if (!check.ok) return [check.code];
  return [];
}

/**
 * Self-test traffic is a label, not an authentication. A caller can only move
 * itself into the self-test bucket.
 *
 * @param {Headers | Record<string, string>} headers
 * @param {string} [agentId]
 */
export function trafficClass(headers, agentId = '') {
  const get = (name) => {
    if (typeof headers?.get === 'function') return headers.get(name) ?? '';
    const lower = name.toLowerCase();
    return headers?.[lower] ?? headers?.[name] ?? '';
  };
  const label = String(get('x-sycee-traffic')).trim().toLowerCase();
  const id = String(get('x-sycee-agent-id') || agentId).trim().toLowerCase();
  if (label === 'self-test') return 'self-test';
  if (id === 'sycee:self-test' || id.startsWith('sycee:self-test:')) return 'self-test';
  return 'external';
}

/**
 * @param {Request} request
 */
export function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim().slice(0, 128);
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().slice(0, 128);
  return 'local';
}

function resolvePrice(env, problems) {
  const atomicRaw = str(env.PRICE_ATOMIC);
  const displayRaw = str(env.PRICE_DISPLAY);
  let atomic = atomicRaw || '';
  let display = displayRaw || '';
  if (!atomic && !display) {
    atomic = '1000';
    display = '0.001000';
  } else if (atomic && !display) {
    display = displayFromAtomic(atomic);
  } else if (!atomic && display) {
    atomic = atomicFromDisplay(display) ?? '';
  }
  if (!/^[1-9]\d*$/.test(atomic) || !display) {
    problems.push('bad_price');
    return { atomic: '1000', display: '0.001000' };
  }
  let value;
  try {
    value = BigInt(atomic);
  } catch {
    problems.push('bad_price');
    return { atomic: '1000', display: '0.001000' };
  }
  if (value <= 0n || value > MAX_PRICE_ATOMIC) {
    problems.push('bad_price');
    return { atomic: '1000', display: '0.001000' };
  }
  const fromDisplay = atomicFromDisplay(display);
  if (fromDisplay == null || fromDisplay !== atomic) {
    problems.push('bad_price');
  }
  const canonical = displayFromAtomic(atomic);
  return { atomic, display: canonical };
}

function displayFromAtomic(atomic) {
  try {
    const n = BigInt(atomic);
    const whole = n / 1000000n;
    const frac = (n % 1000000n).toString().padStart(6, '0');
    return `${whole}.${frac}`;
  } catch {
    return '';
  }
}

function atomicFromDisplay(display) {
  const m = /^(\d{1,7})\.(\d{6})$/.exec(display) || /^(\d{1,7})$/.exec(display);
  if (!m) {
    const loose = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(display);
    if (!loose) return null;
    const whole = BigInt(loose[1]);
    const frac = (loose[2] ?? '').padEnd(6, '0');
    return (whole * 1000000n + BigInt(frac)).toString();
  }
  const whole = BigInt(m[1]);
  const frac = (m[2] ?? '').padEnd(6, '0');
  return (whole * 1000000n + BigInt(frac || '0')).toString();
}

/**
 * Operator-configured URLs only. No userinfo, and plain HTTP only for a
 * loopback host so a local mock facilitator can run. The request path is
 * replaced by the caller; this only checks the origin.
 */
export function checkServiceUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return { ok: false };
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol === 'https:') return { ok: true, host: url.host, origin: url.origin };
    if (url.protocol === 'http:' && local) return { ok: true, host: url.host, origin: url.origin };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export function serviceUrl(base, suffix) {
  const trimmed = String(base).replace(/\/+$/, '');
  const url = new URL(trimmed + suffix);
  url.search = '';
  url.hash = '';
  const check = checkServiceUrl(url.origin);
  if (!check.ok) throw new Error('bad_service_url');
  if (!url.pathname.endsWith(suffix)) throw new Error('bad_service_url');
  return url.toString();
}

function str(value) {
  if (value == null) return '';
  return String(value).trim();
}
