/**
 * Cloudflare Workers entry. Requires the `nodejs_compat` flag: @sycee/core
 * signs with node:crypto (Ed25519) and Buffer. This module does not import
 * node:fs, node:net, or the SQLite adapter.
 */

import { createMerchant } from './merchant.mjs';

/** @type {{ fp: string, merchant: Promise<any> } | null} */
let cached = null;

function fingerprint(env) {
  return [
    env.SYCEE_SIGNING_KEY,
    env.SYCEE_PUBLIC_KEY,
    env.PAY_TO,
    env.NETWORK,
    env.FACILITATOR_URL,
    env.PRICE_ATOMIC,
    env.PRICE_DISPLAY,
    env.ASSET,
    env.ASSET_NAME,
    env.ASSET_VERSION,
    env.MAINNET,
    env.RPC_URL,
    env.RATE_LIMIT_PER_MINUTE,
    env.NEAR_ACCOUNT_ID,
    env.NEAR_CONTRACT_ID,
    env.NEAR_RPC_URL,
    env.NEAR_NETWORK,
    env.NEAR_PRIVATE_KEY,
  ].join('\n');
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   */
  async fetch(request, env) {
    const fp = fingerprint(env);
    if (!cached || cached.fp !== fp) {
      const created = createMerchant(env).catch((err) => {
        cached = null;
        throw err;
      });
      cached = { fp, merchant: created };
    }
    const merchant = await cached.merchant;
    return merchant.fetch(request);
  },
};
