#!/usr/bin/env node
// A second opinion on the refusal extension, written from the prose only.
//
// The existing checkers compare the constructor with the prose tables, and the
// judge compares two implementations that share an author. Neither can answer
// the question a reader has: does the prose decide, on its own, what a
// conforming row must be. So this file is deliberately built from
// `specs/extensions/refusal-row.md` and nothing else, and it validates rows
// that were built by the reference constructor.
//
// Every check below names the sentence it comes from. A check that fails is
// either a row the prose will not accept or a rule the prose states and the
// constructor does not. Both are worth knowing about; neither is decided here.
//
//   node conformance/refusal/prose-reader.mjs
//
// Exit 0: every row the constructor produced is a row the prose accepts.
// Exit 1: at least one row the prose would have to reject.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateKeyPair,
  refusalRow,
  signRefusal,
  exportClaim,
  attemptIdentity,
} from '../../packages/core/src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = path.join(HERE, 'vectors')

/* ------------------------------------------------------------------ *
 * The prose, transcribed. Not imported: an import would make this a third
 * copy of the same table, which is the failure this file exists to avoid.
 * ------------------------------------------------------------------ */

// §5, first table.
const CEILING = {
  invalid_signature: 'client_verifiable',
  wrong_amount: 'client_verifiable',
  wrong_recipient: 'client_verifiable',
  malformed_payload: 'client_verifiable',
  authorization_expired: 'chain_verifiable',
  authorization_not_yet_valid: 'chain_verifiable',
  insufficient_funds: 'issuer_asserted',
  duplicate_payment: 'chain_verifiable',
  nonce_already_used: 'chain_verifiable',
  transfer_leg_failed: 'issuer_asserted',
  facilitator_timeout: 'issuer_asserted',
  risk_policy_rejected: 'issuer_asserted',
  commercial_refusal: 'issuer_asserted',
  internal_error: 'issuer_asserted',
}

// §5, second table. The prose gives a settlement claim for each and no ceiling.
const REPEAT = {
  replay_already_settled: { settlement: ['settled'], final: null },
  replay_in_flight: { settlement: ['pending'], final: false },
  could_not_compare: { settlement: ['unknown'], final: null },
}

const CLOSED = new Set([...Object.keys(CEILING), ...Object.keys(REPEAT)])
const ORDER = ['issuer_asserted', 'client_verifiable', 'chain_verifiable', 'independently_witnessed']

// §15.4. A bare list is required — the row must carry the leg; a bracketed list
// is bounded optional — the row may leave the leg out, and if it records it the
// value must be one of those.
const LEGS_REQUIRED = {
  invalid_signature: { authorization: ['failed', 'unknown'] },
  wrong_amount: { authorization: ['failed', 'unknown'] },
  wrong_recipient: { authorization: ['failed', 'unknown'] },
  malformed_payload: { authorization: ['failed', 'unknown', 'not_reached'] },
  authorization_expired: { authorization: ['failed', 'unknown'] },
  authorization_not_yet_valid: { authorization: ['failed', 'unknown'] },
  insufficient_funds: { authorization: ['failed', 'unknown'] },
  nonce_already_used: { authorization: ['failed', 'executed'] },
  transfer_leg_failed: { authorization: ['executed'], transfer: ['failed'] },
  facilitator_timeout: { authorization: ['unknown'] },
  internal_error: { authorization: ['executed', 'unknown'] },
  risk_policy_rejected: { authorization: ['not_reached', 'unknown'] },
  commercial_refusal: { authorization: ['not_reached', 'unknown'] },
  replay_already_settled: { authorization: ['executed'] },
  duplicate_payment: { authorization: ['executed'] },
  replay_in_flight: {},
  could_not_compare: {},
}

const LEGS_BOUNDED = {
  invalid_signature: { transfer: ['not_reached'] },
  wrong_amount: { transfer: ['not_reached'] },
  wrong_recipient: { transfer: ['not_reached'] },
  malformed_payload: { transfer: ['not_reached'] },
  authorization_expired: { transfer: ['not_reached'] },
  authorization_not_yet_valid: { transfer: ['not_reached'] },
  insufficient_funds: { transfer: ['not_reached'] },
  nonce_already_used: { transfer: ['not_reached', 'failed'] },
  facilitator_timeout: { transfer: ['not_reached', 'unknown'] },
  internal_error: { transfer: ['not_reached', 'unknown'] },
  risk_policy_rejected: { transfer: ['not_reached'] },
  commercial_refusal: { transfer: ['not_reached'] },
  replay_already_settled: { transfer: ['not_reached'] },
  duplicate_payment: { transfer: ['not_reached'] },
  replay_in_flight: { authorization: ['not_reached', 'unknown'], transfer: ['not_reached', 'unknown'] },
  could_not_compare: { authorization: ['not_reached', 'unknown'], transfer: ['not_reached', 'unknown'] },
}

const SETTLEMENT = ['not_submitted', 'pending', 'settled', 'unknown']
const STATUSES = ['not_reached', 'executed', 'failed', 'unknown']

// §15.4, L6. What a recorded leg permits `settlement` to say. Both legs carry a
// row: an authorization that never ran cannot sit beside a settlement that
// landed, and the accepted attempt where that pairing is real — allowance
// approved earlier, `transferFrom` called directly — records no legs at all.
const LEG_SETTLEMENT = {
  authorization: {
    executed: ['not_submitted', 'pending', 'settled', 'unknown'],
    failed: ['not_submitted', 'unknown'],
    not_reached: ['not_submitted', 'unknown'],
    unknown: ['not_submitted', 'pending', 'unknown'],
  },
  transfer: {
    executed: ['settled', 'pending'],
    failed: ['not_submitted', 'unknown'],
    not_reached: ['not_submitted', 'unknown'],
    unknown: ['not_submitted', 'pending', 'unknown'],
  },
}

/* ------------------------------------------------------------------ *
 * The checks, each one a sentence from the prose
 * ------------------------------------------------------------------ */

const problems = []
const add = (code, where, detail) => problems.push({ code, where, detail })

function within(claim, ceiling) {
  return ORDER.indexOf(claim) <= ORDER.indexOf(ceiling)
}

function checkRow(row, where) {
  // §4, field table: the required columns, by name.
  for (const f of [
    'schema_version', 'decision', 'attempt_identity', 'settlement', 'final',
    'resource_id', 'protocol', 'observed_at', 'key_check',
  ]) {
    if (row[f] === undefined) add('R-required', where, `§4 requires ${f}; the row has no such field`)
  }
  if (!row.signer?.public_key || !row.signer?.role) {
    add('R-required', where, '§4 requires signer.public_key and signer.role')
  }
  // §4: `final` MUST be false when settlement is pending.
  if (row.settlement === 'pending' && row.final !== false) {
    add('R-final', where, '§4: final MUST be false when settlement is pending')
  }
  // §4: schema_version is the literal.
  if (row.schema_version !== 'sycee/refusal/v0.1') {
    add('R-version', where, `§4 names sycee/refusal/v0.1; the row says ${row.schema_version}`)
  }
  // §6.1–6.5
  if (row.decision === 'refused') {
    if (!CLOSED.has(row.reason)) {
      add('R-closed', where, `§6.2: ${row.reason} is not in the closed set`)
      return
    }
    // §6.3 / §5: the ceiling. For the three repeat reasons the prose states no
    // ceiling, so the row's own class is unconstrained here — and that is a
    // finding, recorded once below rather than per row.
    const ceiling = CEILING[row.reason]
    if (ceiling && !within(row.evidence_class, ceiling)) {
      add('R-ceiling', where, `§6.3: ${row.reason} claims ${row.evidence_class}, above ${ceiling}`)
    }
    // §5 second table: the settlement each repeat reason claims.
    const rep = REPEAT[row.reason]
    if (rep) {
      if (!rep.settlement.includes(row.settlement)) {
        add('R-repeat', where, `§5: ${row.reason} claims settlement ${rep.settlement.join('|')}; the row says ${row.settlement}`)
      }
      if (rep.final === false && row.final !== false) {
        add('R-repeat', where, `§5: ${row.reason} requires final = false`)
      }
    }
    // §4: reason and reason_detail come together when refused.
    if (!row.reason_detail) add('R-required', where, '§4 requires reason_detail when refused')
    // §15.4, L1–L4 — a bare cell is a required leg, a bracket is bounded optional.
    if (row.legs !== undefined) {
      const required = LEGS_REQUIRED[row.reason]
      const bounded = LEGS_BOUNDED[row.reason]
      if (required === undefined && bounded === undefined) {
        add('R-legs', where, `§15.4: ${row.reason} has no row in the leg table`)
      } else {
        for (const leg of Object.keys(row.legs)) {
          if (leg !== 'authorization' && leg !== 'transfer') {
            add('R-legs', where, `§15.4: ${leg} is not a leg name`)
          } else if (!STATUSES.includes(row.legs[leg])) {
            add('R-legs', where, `§15.4: ${row.legs[leg]} is not an observable status`)
          }
        }
        for (const [leg, allowed] of Object.entries(required ?? {})) {
          if (row.legs[leg] === undefined) {
            add('R-legs', where, `§15.4, L2: ${row.reason} is a claim about ${leg}; the row records nothing about it`)
          } else if (!allowed.includes(row.legs[leg])) {
            add('R-legs', where, `§15.4: ${row.reason}.${leg} = ${row.legs[leg]}, outside ${allowed.join('|')}`)
          }
        }
        for (const [leg, allowed] of Object.entries(bounded ?? {})) {
          if (row.legs[leg] !== undefined && !allowed.includes(row.legs[leg])) {
            add('R-legs', where, `§15.4: ${row.reason}.${leg} = ${row.legs[leg]}, outside ${allowed.join('|')}`)
          }
        }
        if (row.legs.transfer !== undefined && row.legs.transfer !== 'not_reached') {
          if (row.legs.authorization === 'not_reached' || row.legs.authorization === 'failed') {
            add('R-legs', where, `§15.4, L4: transfer = ${row.legs.transfer} requires the authorization leg to have run; the row records ${row.legs.authorization}`)
          }
        }
        // §15.4, L6: a recorded leg and the settlement describe one event, so a
        // row recording both cannot have them tell different stories.
        for (const leg of ['authorization', 'transfer']) {
          const status = row.legs[leg]
          if (status === undefined) continue
          const allowed = LEG_SETTLEMENT[leg]?.[status]
          if (allowed && !allowed.includes(row.settlement)) {
            add('R-legs', where, `§15.4, L6: ${leg} = ${status} and settlement = ${row.settlement} describe different events; ${status} permits ${allowed.join('|')}`)
          }
        }
      }
    }
  }
  // §15.4, L2 read strictly: a reason that makes no leg claim MUST NOT carry leg
  // observations that contradict the absence of a claim. An accepted row carries
  // no reason at all, so any leg observation on it is in the same position.
  if (row.decision === 'accepted' && row.legs !== undefined) {
    add('R-legs', where, '§15.4, L2: an accepted row makes no leg claim, but records legs ' + JSON.stringify(row.legs))
  }
  // §4: `final` is typed boolean, and §6.4 says `final` is false whenever
  // settlement is pending — a string "yes" satisfies neither sentence.
  if (typeof row.final !== 'boolean') {
    add('R-final', where, `§4 types final as boolean; the row says ${JSON.stringify(row.final)}`)
  }
  // §6.4
  if (!SETTLEMENT.includes(row.settlement)) {
    add('R-settlement', where, `§6.4: ${row.settlement} is not one of the four settlement values`)
  }
}

/* ------------------------------------------------------------------ *
 * Build rows the constructor will produce, then read them as a stranger
 * ------------------------------------------------------------------ */

const keys = generateKeyPair()
const identity = () => attemptIdentity({
  method: 'POST', origin: 'https://seller.example', path: '/probe', query: '',
  payTo: '0x00000000000000000000000000000000000000aa', asset: 'USDC',
  network: 'eip155:8453', amount: '0.02', scheme: 'exact',
})

const cases = [
  { label: 'accepted, not submitted', input: { decision: 'accepted', settlement: 'not_submitted' } },
  { label: 'accepted, settled', input: { decision: 'accepted', settlement: 'settled' } },
  ...Object.keys(CEILING).map((reason) => ({
    label: `refused ${reason}`,
    input: { decision: 'refused', reason, settlement: 'not_submitted' },
  })),
  ...Object.keys(REPEAT).map((reason) => ({
    label: `refused ${reason}`,
    input: { decision: 'refused', reason, settlement: REPEAT[reason].settlement[0] },
  })),
  {
    label: 'refused transfer_leg_failed with its legs',
    input: { decision: 'refused', reason: 'transfer_leg_failed', settlement: 'not_submitted', legs: { authorization: 'executed', transfer: 'failed' } },
  },
  {
    label: 'refused wrong_amount with a leg observation',
    input: { decision: 'refused', reason: 'wrong_amount', settlement: 'not_submitted', legs: { authorization: 'failed' } },
  },
  {
    label: 'refused replay_in_flight with a leg observation',
    input: { decision: 'refused', reason: 'replay_in_flight', settlement: 'pending', legs: { authorization: 'unknown' } },
  },
  {
    label: 'refused internal_error recording what it saw on both legs',
    input: { decision: 'refused', reason: 'internal_error', settlement: 'not_submitted', legs: { authorization: 'executed', transfer: 'unknown' } },
  },
  {
    label: 'refused internal_error naming a failed transfer',
    input: { decision: 'refused', reason: 'internal_error', settlement: 'not_submitted', legs: { authorization: 'unknown', transfer: 'failed' } },
    expect: 'refuse',
    code: 'leg_contradicts_reason',
  },
  {
    label: 'refused nonce_already_used with the second leg reached before the first',
    input: { decision: 'refused', reason: 'nonce_already_used', settlement: 'not_submitted', legs: { authorization: 'failed', transfer: 'failed' } },
    expect: 'refuse',
    code: 'leg_contradicts_reason',
  },
  {
    label: 'refused could_not_compare with a leg observation',
    input: { decision: 'refused', reason: 'could_not_compare', settlement: 'unknown', legs: { authorization: 'unknown' } },
  },
  {
    label: 'refused internal_error: permit landed, transfer never sent',
    input: { decision: 'refused', reason: 'internal_error', settlement: 'not_submitted', legs: { authorization: 'executed', transfer: 'not_reached' } },
  },
  {
    label: 'refused internal_error with a settled rail beside a transfer never sent',
    input: { decision: 'refused', reason: 'internal_error', settlement: 'settled', legs: { authorization: 'executed', transfer: 'not_reached' } },
    expect: 'refuse',
    code: 'settlement_contradicts_leg',
  },
  {
    label: 'refused risk_policy_rejected with a settlement that landed',
    input: { decision: 'refused', reason: 'risk_policy_rejected', settlement: 'settled', legs: { authorization: 'not_reached' } },
    expect: 'refuse',
    code: 'settlement_contradicts_leg',
  },
  {
    label: 'refused facilitator_timeout with a transfer never sent beside a pending rail',
    input: { decision: 'refused', reason: 'facilitator_timeout', settlement: 'pending', legs: { authorization: 'unknown', transfer: 'not_reached' } },
    expect: 'refuse',
    code: 'settlement_contradicts_leg',
  },
  {
    label: 'accepted with a failed leg recorded',
    input: { decision: 'accepted', settlement: 'settled', legs: { authorization: 'failed' } },
    expect: 'refuse',
    code: 'legs_without_reason',
  },
  {
    label: 'a row whose final is a string',
    input: { decision: 'accepted', settlement: 'settled', final: 'yes' },
    expect: 'refuse',
    code: 'final_not_boolean',
  },
]

let built = 0
let refusedAsExpected = 0
let rejectedByProse = 0
// A case says which way the prose decides it. Without that, a checker can only
// notice a constructor that is too loose; one that is too strict looks like a
// refusal it has no opinion about, and the difference is the whole point.
for (const c of cases) {
  const build = () => refusalRow({
    ...c.input,
    attemptIdentity: identity(),
    signingPublicKey: keys.publicKey,
    resourceId: 'probe',
    protocol: 'x402',
    observedAt: '2026-11-21T00:00:00.000Z',
  })

  if (c.expect === 'refuse') {
    try {
      build()
      add('C-too-lax', c.label, 'the prose forbids this row; the constructor built it')
    } catch (err) {
      const code = /^refusalRow: ([a-z_]+) — /.exec(String(err.message))?.[1]
      if (c.code && code !== c.code) {
        add('C-wrong-code', c.label, `refused, but as ${code} rather than ${c.code}: ${err.message}`)
      }
      refusedAsExpected++
    }
    continue
  }

  let row
  try {
    row = build()
  } catch (err) {
    add('C-too-strict', c.label, `the prose allows this row; the constructor refused it: ${err.message}`)
    continue
  }
  built++
  const before = problems.length
  checkRow(row, c.label)
  if (problems.length > before) rejectedByProse++
}

/* ------------------------------------------------------------------ *
 * The claim: §7 and SPEC §5.5.7
 * ------------------------------------------------------------------ */

const envelope = signRefusal(
  refusalRow({
    decision: 'refused',
    reason: 'wrong_amount',
    settlement: 'not_submitted',
    attemptIdentity: identity(),
    signingPublicKey: keys.publicKey,
    resourceId: 'probe',
    protocol: 'x402',
    observedAt: '2026-11-21T00:00:00.000Z',
  }),
  keys.privateKey,
)
const claim = exportClaim(envelope)

// §7's shape: five keys, no more. A verifier that reads the five and ignores the
// rest will accept a claim carrying anything else, so this is worth saying.
const declared = ['type', 'version', 'refusal', 'signature', 'claim_id', 'issued_at']
for (const k of Object.keys(claim)) {
  if (!declared.includes(k)) add('C-shape', 'claim', `§7 declares six keys; the claim carries ${k}`)
}

/* ------------------------------------------------------------------ */

const label = (p) => `  ${p.code.padEnd(13)} ${p.where}\n${' '.repeat(18)}${p.detail}`
console.log(`prose reader: ${built} rows built, ${refusedAsExpected} refused as the prose says they must be`)
console.log(`              ${rejectedByProse} of those rows fail a rule the prose states`)
console.log(`              ${problems.length} finding(s)\n`)
for (const p of problems) console.log(label(p))
if (problems.length === 0) {
  console.log('Every row the constructor produces is a row the prose accepts.')
  process.exit(0)
}
process.exit(1)
