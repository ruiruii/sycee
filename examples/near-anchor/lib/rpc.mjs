/**
 * Read-only NEAR RPC, and a signed function call via near-api-js.
 * Mainnet is refused. The anchor script never creates an account.
 * Signing keys are never written to logs.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const TESTNET_RPC = 'https://rpc.testnet.near.org';

export function networkConfig() {
  const network = process.env.NEAR_NETWORK ?? 'testnet';
  if (network === 'mainnet' || network === 'near') {
    throw new Error('refusing mainnet');
  }
  if (network !== 'testnet' && network !== 'sandbox' && network !== 'localnet') {
    throw new Error(`unsupported NEAR_NETWORK ${network}`);
  }
  const rpcUrl = process.env.NEAR_RPC_URL || (network === 'testnet' ? TESTNET_RPC : '');
  if (!rpcUrl) throw new Error('Set NEAR_RPC_URL for a local sandbox');
  if (network === 'testnet' && /mainnet/i.test(rpcUrl)) throw new Error('refusing a mainnet RPC');
  return { network, rpcUrl };
}

/**
 * @param {string} contractId
 * @param {string} method
 * @param {object} args
 */
export async function viewCall(contractId, method, args) {
  const { rpcUrl } = networkConfig();
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'sycee-anchor',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
      },
    }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) {
    const message = body.error.data ?? body.error.message ?? 'RPC error';
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  const bytes = body.result?.result;
  if (!Array.isArray(bytes)) throw new Error('RPC response did not include a result');
  const text = Buffer.from(bytes).toString('utf8');
  return text === 'null' ? null : JSON.parse(text);
}

/**
 * `~/.near-credentials/<network>/<account>.json`, the near-cli legacy keychain.
 * @param {string} network
 * @param {string} accountId
 * @param {string} [home]
 */
export function legacyCredentialsPath(network, accountId, home = homedir()) {
  return path.join(home, '.near-credentials', network, `${accountId}.json`);
}

/**
 * Prefer NEAR_PRIVATE_KEY. Otherwise read private_key from the legacy file.
 * The returned string is the key. Callers must not log it or put it in an error.
 *
 * @param {{ network: string, accountId: string, env?: NodeJS.ProcessEnv, home?: string }} input
 */
export async function signingKeyFromEnvOrFile(input) {
  const env = input.env ?? process.env;
  if (typeof env.NEAR_PRIVATE_KEY === 'string' && env.NEAR_PRIVATE_KEY.length > 0) {
    return env.NEAR_PRIVATE_KEY;
  }
  const file = legacyCredentialsPath(input.network, input.accountId, input.home);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(
      `Set NEAR_PRIVATE_KEY or provide ~/.near-credentials/${input.network}/${input.accountId}.json`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('NEAR credentials file is not valid JSON');
  }
  const secret = parsed && (parsed.private_key || parsed.secret_key);
  if (typeof secret !== 'string' || !secret.startsWith('ed25519:')) {
    throw new Error('NEAR credentials file has no ed25519 private_key');
  }
  return secret;
}

/**
 * @param {string} method
 * @param {object} args
 */
export async function changeCall(method, args) {
  const { network, rpcUrl } = networkConfig();
  const accountId = process.env.NEAR_ACCOUNT_ID;
  const contractId = process.env.NEAR_CONTRACT_ID;
  if (!accountId || !contractId) {
    throw new Error('Set NEAR_ACCOUNT_ID and NEAR_CONTRACT_ID');
  }
  if (/\.near$/.test(accountId) || /\.near$/.test(contractId)) {
    throw new Error('refusing a mainnet-style *.near account');
  }
  const secret = await signingKeyFromEnvOrFile({ network, accountId });
  const { connect, keyStores, KeyPair } = await import('near-api-js');
  let keyPair;
  try {
    keyPair = KeyPair.fromString(secret);
  } catch {
    throw new Error('NEAR private key could not be parsed. Expected an ed25519: string.');
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(network, accountId, keyPair);
  const near = await connect({
    networkId: network,
    nodeUrl: rpcUrl,
    keyStore,
  });
  const account = await near.account(accountId);
  return account.functionCall({
    contractId,
    methodName: method,
    args,
    gas: '100000000000000',
    attachedDeposit: '0',
  });
}
