/**
 * Read-only NEAR RPC, and a signed function call via near-api-js.
 * Mainnet is refused. The anchor script never creates an account.
 */

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
 * @param {string} method
 * @param {object} args
 */
export async function changeCall(method, args) {
  const { network, rpcUrl } = networkConfig();
  const accountId = process.env.NEAR_ACCOUNT_ID;
  const contractId = process.env.NEAR_CONTRACT_ID;
  const secret = process.env.NEAR_PRIVATE_KEY;
  if (!accountId || !contractId || !secret) {
    throw new Error('Set NEAR_ACCOUNT_ID, NEAR_CONTRACT_ID, and NEAR_PRIVATE_KEY');
  }
  if (/\.near$/.test(accountId) || /\.near$/.test(contractId)) {
    throw new Error('refusing a mainnet-style *.near account');
  }
  const { connect, keyStores, KeyPair } = await import('near-api-js');
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(network, accountId, KeyPair.fromString(secret));
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
