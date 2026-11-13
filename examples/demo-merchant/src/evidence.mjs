/**
 * Public evidence view.
 *
 * Consumed yes/no/unknown counts are computed only from agent-signed receipts.
 * Merchant receipts stay consumed=unknown and are not part of the bucket.
 * The split is omitted until the bucket holds at least k agent receipts.
 * `unknown` is never folded into `yes`.
 */

import { K_MIN } from './config.mjs';

export { K_MIN };

/**
 * @param {string} hash
 */
export function truncateProofHash(hash) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(hash ?? ''));
  if (!match) return 'sha256:invalid';
  return `sha256:${match[1].slice(0, 8)}…${match[1].slice(-4)}`;
}

/**
 * @param {object} config
 * @param {object} stats from the store
 * @param {{ publicKey: string | null, storeKind: string, problems: string[] }} meta
 */
export function presentEvidence(config, stats, meta) {
  const consumed = publishConsumed(stats.consumed);
  return {
    service: 'sycee-demo-merchant',
    statement:
      'SYCEE team first-party demo merchant. Records only. No scoring, no custody, no fund movement.',
    configured: meta.problems.length === 0,
    problems: meta.problems,
    store: meta.storeKind,
    config: {
      network: config.network,
      price: { value: config.priceDisplay, currency: config.currency, atomic: config.priceAtomic },
      pay_to: config.payTo || null,
      facilitator: config.facilitatorUrl,
      asset: config.asset || null,
      public_key: meta.publicKey,
      merchant_agent_id: config.agentId,
      resource_id: config.resourceId,
      mainnet_enabled: config.mainnetEnabled,
    },
    decisions: { accepted: stats.accepted, refused: stats.refused },
    redeem_count: {
      eq1: stats.redeem.eq1,
      gt1: stats.redeem.gt1,
      max: stats.redeem.max,
      note: 'redeem_count counts attempts, including refused replays. It is incremented before the accept or refuse decision.',
    },
    settlement: stats.settlement,
    consumed,
    traffic: {
      self_test: stats.traffic.self_test,
      external: stats.traffic.external,
      note: 'self-test is a label (header x-sycee-traffic: self-test, or agent_id sycee:self-test), not an authentication. Unlabeled calls are counted as external, including any self-traffic that omitted the label.',
    },
    recent: stats.recent.map((row) => ({
      proof_hash: truncateProofHash(row.proof_hash),
      redeem_count: row.redeem_count,
      settlement: row.settlement,
      delivery: row.delivery,
      decision: row.decision,
      traffic: row.traffic,
      at: row.at,
    })),
  };
}

function publishConsumed(raw) {
  const k = raw?.k ?? 0;
  const yes = raw?.yes ?? 0;
  const no = raw?.no ?? 0;
  const unknown = raw?.unknown ?? 0;
  if (k < K_MIN) {
    return {
      published: false,
      k,
      label: 'not published (k<10)',
    };
  }
  return {
    published: true,
    k,
    yes,
    no,
    unknown,
    note: 'unknown is not counted as yes. Only agent-signed receipts are in this bucket; merchant receipts are consumed=unknown and are excluded.',
  };
}

export function renderDashboard(view) {
  const c = view.config;
  const rows = view.recent.length
    ? view.recent.map((row) => `<tr>
        <td>${esc(row.at)}</td>
        <td><code>${esc(row.proof_hash)}</code></td>
        <td>${esc(row.redeem_count)}</td>
        <td>${esc(row.settlement)}</td>
        <td>${esc(row.delivery)}</td>
        <td>${esc(row.decision)}</td>
        <td>${esc(row.traffic)}</td>
      </tr>`).join('')
    : '<tr><td colspan="7">No receipts yet.</td></tr>';

  const consumed = view.consumed.published
    ? `<p>Published (k=${esc(view.consumed.k)}). yes ${esc(view.consumed.yes)}, no ${esc(view.consumed.no)}, unknown ${esc(view.consumed.unknown)}.</p>
       <p>${esc(view.consumed.note)}</p>`
    : `<p><strong>${esc(view.consumed.label)}</strong> (k=${esc(view.consumed.k)}). The yes / no / unknown split is hidden. unknown is never counted as yes.</p>`;

  const problems = view.problems.length
    ? `<p class="warn">Not payable until configured: ${esc(view.problems.join(', '))}.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SYCEE demo merchant</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 16px/1.45 Georgia, "Iowan Old Style", serif; color: #1a1a1a; background: #f7f5f0; }
  header, main { max-width: 52rem; margin: 0 auto; padding: 1.25rem 1.25rem 0; }
  header { padding-top: 1.75rem; }
  h1 { font-size: 1.6rem; margin: 0 0 0.4rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.15rem; margin: 1.6rem 0 0.4rem; }
  .banner { background: #1a1a1a; color: #f7f5f0; padding: 0.9rem 1rem; }
  .banner p { margin: 0.35rem 0; }
  dl { display: grid; grid-template-columns: 11rem 1fr; gap: 0.25rem 0.75rem; margin: 0.5rem 0; }
  dt { color: #444; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code, .num { font-family: ui-monospace, "Cascadia Code", monospace; font-size: 0.92em; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; background: #fff; }
  th, td { text-align: left; padding: 0.35rem 0.45rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem; }
  .card { background: #fff; border: 1px solid #e2ddd4; padding: 0.75rem 0.9rem; }
  .card strong { font-family: ui-monospace, monospace; font-size: 1.25rem; }
  .warn { background: #fff6d8; padding: 0.6rem 0.75rem; }
  footer { max-width: 52rem; margin: 0 auto; padding: 1.25rem; color: #444; font-size: 0.92rem; }
</style>
</head>
<body>
<header>
  <h1>SYCEE demo merchant</h1>
  <div class="banner">
    <p>This is the SYCEE team's own first-party demo merchant.</p>
    <p>Records only. No scoring, no custody, no fund movement.</p>
    <p>The configured x402 facilitator submits the buyer's authorization. This service does not hold a payer key and does not custody funds.</p>
  </div>
</header>
<main>
  ${problems}
  <h2>Configuration</h2>
  <dl>
    <dt>Network</dt><dd><code>${esc(c.network)}</code>${c.mainnet_enabled ? '' : ' (mainnet not enabled)'}</dd>
    <dt>Price</dt><dd>${esc(c.price.value)} ${esc(c.price.currency)} <span class="num">(${esc(c.price.atomic)} atomic)</span></dd>
    <dt>payTo</dt><dd><code>${esc(c.pay_to ?? 'not configured')}</code></dd>
    <dt>Facilitator</dt><dd><code>${esc(c.facilitator)}</code></dd>
    <dt>Asset</dt><dd><code>${esc(c.asset ?? 'not configured')}</code></dd>
    <dt>Merchant Ed25519</dt><dd><code>${esc(c.public_key ?? 'not configured')}</code></dd>
    <dt>Store</dt><dd>${esc(view.store)}</dd>
  </dl>

  <h2>Decisions</h2>
  <div class="grid">
    <div class="card"><div>Accepted</div><strong>${esc(view.decisions.accepted)}</strong></div>
    <div class="card"><div>Refused</div><strong>${esc(view.decisions.refused)}</strong></div>
  </div>

  <h2>redeem_count</h2>
  <div class="grid">
    <div class="card"><div>= 1</div><strong>${esc(view.redeem_count.eq1)}</strong></div>
    <div class="card"><div>&gt; 1</div><strong>${esc(view.redeem_count.gt1)}</strong></div>
    <div class="card"><div>max</div><strong>${esc(view.redeem_count.max)}</strong></div>
  </div>
  <p>${esc(view.redeem_count.note)}</p>

  <h2>Settlement</h2>
  <div class="grid">
    <div class="card"><div>settled</div><strong>${esc(view.settlement.settled)}</strong></div>
    <div class="card"><div>in_flight</div><strong>${esc(view.settlement.in_flight)}</strong></div>
    <div class="card"><div>absent</div><strong>${esc(view.settlement.absent)}</strong></div>
  </div>

  <h2>Consumed</h2>
  ${consumed}

  <h2>Traffic</h2>
  <div class="grid">
    <div class="card"><div>self-test</div><strong>${esc(view.traffic.self_test)}</strong></div>
    <div class="card"><div>external</div><strong>${esc(view.traffic.external)}</strong></div>
  </div>
  <p>${esc(view.traffic.note)}</p>

  <h2>Recent receipts</h2>
  <p>Proof hashes are truncated. Raw payment proofs are not stored and are not shown. redeem_count on a row is the count after that attempt, including a refused replay.</p>
  <table>
    <thead><tr><th>Time</th><th>proof_hash</th><th>redeem_count</th><th>Settlement</th><th>Delivery</th><th>Decision</th><th>Traffic</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</main>
<footer>
  Paid route <code>GET /v1/base/tip</code>. Agent receipts <code>POST /v1/agent-receipt</code>.
  Machine-readable copy at <a href="/evidence.json">/evidence.json</a>.
</footer>
</body>
</html>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
