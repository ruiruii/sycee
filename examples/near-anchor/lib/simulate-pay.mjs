/**
 * One local purchase against the demo merchant.
 * The facilitator and the Base block are stand-ins. No wallet is used and no
 * chain transfer happens. Callers must say so in their output.
 */

import { randomBytes } from 'node:crypto';
import { generateKeyPair } from '@sycee/core';
import { createMerchant } from '../../demo-merchant/src/merchant.mjs';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER = '0x1111111111111111111111111111111111111111';

function paymentHeader() {
  const payload = {
    x402Version: 2,
    resource: {
      url: 'http://127.0.0.1/v1/base/tip',
      description: 'Latest Base block number, timestamp, and base fee',
      mimeType: 'application/json',
    },
    accepted: {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '1000',
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
    payload: {
      signature: `0x${randomBytes(65).toString('hex')}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: '1000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${randomBytes(32).toString('hex')}`,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * @returns {Promise<{ envelope: object, httpStatus: number, simulated: true, payTo: string }>}
 */
export async function simulatedPurchase() {
  const keys = generateKeyPair();
  const merchant = await createMerchant({
    PAY_TO,
    NETWORK: 'eip155:84532',
    SYCEE_SIGNING_KEY: keys.privateKey,
    RATE_LIMIT_PER_MINUTE: '1000',
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith('/verify')) {
        return Response.json({ isValid: true, payer: PAYER });
      }
      if (target.endsWith('/settle')) {
        return Response.json({
          success: true,
          transaction: `0x${randomBytes(32).toString('hex')}`,
          network: 'eip155:84532',
          payer: PAYER,
        });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { number: '0x10', timestamp: '0x67400000', baseFeePerGas: '0x3b9aca00' },
      });
    },
  });
  const response = await merchant.fetch(new Request('http://127.0.0.1/v1/base/tip', {
    headers: {
      'payment-signature': paymentHeader(),
      'x-sycee-traffic': 'self-test',
    },
  }));
  if (response.status !== 200) {
    const text = await response.text();
    throw new Error(`local merchant returned ${response.status}: ${text.slice(0, 180)}`);
  }
  const raw = response.headers.get('x-gates-receipt');
  if (!raw) throw new Error('local merchant did not return a receipt');
  const envelope = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  return { envelope, httpStatus: response.status, simulated: true, payTo: PAY_TO };
}
