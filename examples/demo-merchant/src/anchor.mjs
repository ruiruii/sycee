/**
 * Optional NEAR anchoring of one merchant receipt.
 *
 * The call matches examples/near-anchor/scripts/anchor.mjs: method `anchor`,
 * attached deposit 0, hash only. SYCEE does not hold the USDC and does not
 * move it. The NEAR key is a function-call key the operator supplies. This
 * file never prints that key and never creates an account.
 *
 * Anchoring is off unless readNearConfig marked the deployment enabled.
 * A failure here does not change the HTTP status of a payment that already
 * settled: the buyer still receives the block and the signed receipt.
 */

import { digestHex, receiptHash } from './fingerprint.mjs';

const ANCHOR_TIMEOUT_MS = 12_000;

/**
 * @param {{
 *   envelope: object,
 *   near: {
 *     enabled: boolean,
 *     problems?: string[],
 *     privateKey?: string,
 *     accountId?: string,
 *     contractId?: string,
 *     network?: string,
 *     rpcUrl?: string,
 *     sourceChain?: string,
 *     merchantId?: string,
 *   },
 *   anchorImpl?: (input: object) => Promise<any>,
 * }} input
 */
export async function anchorSignedReceipt(input) {
  const { envelope, near } = input;
  let hash = '';
  try {
    hash = receiptHash(envelope);
  } catch {
    return { status: 'failed', reason: 'bad_receipt', receipt_hash: null, contract: near?.contractId ?? null };
  }
  const contract = near?.contractId ?? null;
  if (!near?.enabled) {
    return {
      status: 'skipped',
      reason: near?.problems?.[0] || 'not_configured',
      receipt_hash: hash,
      contract,
    };
  }

  const args = {
    receipt_hash: digestHex(hash),
    source_chain: near.sourceChain,
    merchant_id: near.merchantId,
    batch_root: null,
  };
  try {
    const call = input.anchorImpl ?? nearFunctionCall;
    const result = await withTimeout(call({
      method: 'anchor',
      args,
      attachedDeposit: '0',
      contractId: near.contractId,
      accountId: near.accountId,
      rpcUrl: near.rpcUrl,
      network: near.network,
      privateKey: input.anchorImpl ? undefined : near.privateKey,
    }), ANCHOR_TIMEOUT_MS);
    return {
      status: 'submitted',
      reason: null,
      receipt_hash: hash,
      contract,
      transaction_hash: txHashOf(result),
    };
  } catch (err) {
    const reason = classifyNearError(err);
    return {
      status: reason === 'already_anchored' ? 'duplicate' : 'failed',
      reason,
      receipt_hash: hash,
      contract,
    };
  }
}

/**
 * Signed function call. Deposit is fixed at 0. Mainnet is refused before
 * any client library loads. The private key is passed only to KeyPair and
 * is not interpolated into errors.
 *
 * @param {{
 *   method: string,
 *   args: object,
 *   attachedDeposit: string,
 *   contractId: string,
 *   accountId: string,
 *   rpcUrl: string,
 *   network: string,
 *   privateKey?: string,
 * }} input
 */
export async function nearFunctionCall(input) {
  if (input.attachedDeposit !== '0') {
    throw coded('deposit_refused');
  }
  if (input.network === 'mainnet' || input.network === 'near') throw coded('near_mainnet_refused');
  if (/\.near$/.test(String(input.accountId)) || /\.near$/.test(String(input.contractId))) {
    throw coded('near_mainnet_refused');
  }
  if (/mainnet/i.test(String(input.rpcUrl))) throw coded('near_mainnet_refused');
  if (!input.privateKey || !input.privateKey.startsWith('ed25519:') || input.privateKey.startsWith('ed25519-priv:')) {
    throw coded('near_key_malformed');
  }
  let nearApi;
  try {
    nearApi = await import('near-api-js');
  } catch {
    throw coded('anchor_client_missing');
  }
  const { connect, keyStores, KeyPair } = nearApi;
  let keyPair;
  try {
    keyPair = KeyPair.fromString(input.privateKey);
  } catch {
    throw coded('near_key_malformed');
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(input.network, input.accountId, keyPair);
  const near = await connect({
    networkId: input.network,
    nodeUrl: input.rpcUrl,
    keyStore,
  });
  const account = await near.account(input.accountId);
  return account.functionCall({
    contractId: input.contractId,
    methodName: input.method,
    args: input.args,
    gas: '100000000000000',
    attachedDeposit: '0',
  });
}

/**
 * Read-only get_anchor, same query body as examples/near-anchor/lib/rpc.mjs viewCall.
 *
 * @param {typeof fetch} fetchImpl
 * @param {{ rpcUrl: string, contractId: string, digest: string }} target
 */
export async function lookupAnchor(fetchImpl, target) {
  let response;
  try {
    response = await fetchImpl(target.rpcUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'sycee-anchor',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: target.contractId,
          method_name: 'get_anchor',
          args_base64: Buffer.from(JSON.stringify({ receipt_hash: target.digest }), 'utf8').toString('base64'),
        },
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    const name = err && /** @type {any} */ (err).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw coded('near_timeout');
    throw coded('chain_lookup_failed');
  }
  if (!response.ok || (response.status >= 300 && response.status < 400)) throw coded('chain_lookup_failed');
  const text = await response.text();
  if (text.length > 65_536) throw coded('chain_lookup_failed');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw coded('chain_lookup_failed');
  }
  if (body.error) throw coded('chain_lookup_failed');
  const bytes = body.result?.result;
  if (!Array.isArray(bytes)) throw coded('chain_lookup_failed');
  const decoded = Buffer.from(bytes).toString('utf8');
  if (decoded === 'null') return null;
  const record = JSON.parse(decoded);
  if (!record || typeof record !== 'object') throw coded('chain_lookup_failed');
  return record;
}

function txHashOf(result) {
  const hash = result?.transaction?.hash ?? result?.transaction_outcome?.id ?? null;
  if (typeof hash !== 'string') return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,100}$/.test(hash)) return null;
  return hash;
}

function classifyNearError(err) {
  const code = err && /** @type {any} */ (err).code;
  if (typeof code === 'string' && /^[a-z0-9_]+$/.test(code)) return code;
  const text = String(err && err.message ? err.message : '');
  if (/near_timeout|timed out|timeout/i.test(text)) return 'near_timeout';
  if (/already|duplicate|exists/i.test(text)) return 'already_anchored';
  if (/deposit/i.test(text)) return 'deposit_refused';
  if (/mainnet/i.test(text)) return 'near_mainnet_refused';
  if (/anchor_client_missing|near-api-js/i.test(text)) return 'anchor_client_missing';
  if (/near_key_malformed/i.test(text)) return 'near_key_malformed';
  return 'near_rejected';
}

function coded(code) {
  const err = new Error(code);
  /** @type {any} */ (err).code = code;
  return err;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(coded('near_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
