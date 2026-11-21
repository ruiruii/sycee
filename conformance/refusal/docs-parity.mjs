#!/usr/bin/env node
// Documentation parity check.
//
// The section 15 vectors were failed by a reader who had only the prose. Three
// of the four disagreements were cases where a rule lived in one place and was
// written down in another. This script exists so that cannot happen again
// quietly: it parses the two tables a reader depends on out of the markdown and
// compares them with the tables the constructor uses.
//
// It is a diff, not a judgement. It does not know which side is right; it only
// refuses to let the two sides drift apart.
//
//   node conformance/refusal/docs-parity.mjs
//
// Exit 0: the prose and the code agree. Exit 1: they do not. Exit 2: the script
// could not read one of the sources, which is never a pass.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REQUIRED_LEG_STATUS,
  BOUNDED_LEG_STATUS,
  REASON_SETTLEMENT,
  REASON_CEILING,
  REFUSAL_REASONS,
  ceilingFor,
  reproducibleCeiling,
} from '../../packages/core/src/refusal.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const EXT = path.join(ROOT, 'specs/extensions/refusal-row.md')
const SPEC = path.join(ROOT, 'SPEC.md')

const problems = []
const fail = (where, detail) => problems.push({ where, detail })

/** Rows of every markdown table whose header line contains all the needles. */
function tablesAfter(md, headerNeedles) {
  const lines = md.split('\n')
  const out = []
  // A header row is the line above a |---|---| separator. Matching on column names
  // alone also matches data rows that happen to begin with a cell named "reason".
  const isSeparator = (x) => /^\|[-\s:|]+\|$/.test(x.trim())
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('|') || !isSeparator(lines[i + 1] ?? '')) continue
    const cells = l.split('|').map((c) => c.replace(/`/g, '').trim().toLowerCase())
    if (!headerNeedles.every((n) => cells.some((c) => c.includes(n)))) continue
    const rows = []
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
      rows.push(lines[j].split('|').map((c) => c.trim()))
    }
    out.push({ header: cells, rows })
    i = i + 1 + rows.length
  }
  return out
}

const ext = fs.readFileSync(EXT, 'utf8')
const spec = fs.readFileSync(SPEC, 'utf8')

/* ------------------------------------------------------------------ *
 * 1. The closed reason set: prose §5 vs REFUSAL_REASONS
 * ------------------------------------------------------------------ */

// §5 keeps two tables: the closed reasons, and the three that describe a repeat
// presentation. A reader needs both, so both are read.
// Header cell 1 must be exactly "reason": §4's field table also mentions reasons
// in its rows, and picking that up would compare field names against reasons.
const reasonTables = tablesAfter(ext, ['reason']).filter((t) => t.header[1] === 'reason')
if (reasonTables.length === 0) fail('refusal-row.md', 'no table whose second column is "reason"')
else {
  const inProse = new Set()
  for (const { rows } of reasonTables) {
    for (const r of rows) {
      const name = r[1].replace(/`/g, '').trim()
      if (!/^[a-z_]+$/.test(name)) continue // header separators, "anything else"
      inProse.add(name)
    }
  }
  // REFUSAL_REASONS carries `accepted` as a null entry; it is a decision, not a reason.
  const inCode = new Set(Object.keys(REFUSAL_REASONS).filter((k) => k !== 'accepted'))

  for (const r of inProse) {
    if (!inCode.has(r)) fail('closed reason set', `§5 lists "${r}" but REFUSAL_REASONS does not accept it`)
  }
  for (const r of inCode) {
    if (!inProse.has(r)) fail('closed reason set', `REFUSAL_REASONS has "${r}" but §5 does not list it`)
  }
}

/* ------------------------------------------------------------------ *
 * 2. The leg contract: prose §15.4 vs REQUIRED_LEG_STATUS
 * ------------------------------------------------------------------ */

const legRows = tablesAfter(ext, ['reason', 'authorization']).find((t) => t.header[1] === 'reason')?.rows
if (!legRows) fail('refusal-row.md', 'no table with columns "reason" and "authorization"')
else {
  // A bare list is required; a bracketed list is bounded optional; a dash is
  // neither. The two marks are the whole point of the table — see §15.4.
  const parse = (cell) => {
    const t = cell.replace(/`/g, '').trim()
    if (!t || t === '—') return null
    const optional = /^\[.*\]$/.test(t)
    const inner = optional ? t.slice(1, -1) : t
    return {
      required: !optional,
      values: inner.split(',').map((x) => x.trim()).filter(Boolean).sort(),
    }
  }
  const prose = new Map()
  for (const r of legRows) {
    const name = r[1].replace(/`/g, '').trim()
    if (!/^[a-z_]+$/.test(name)) continue
    prose.set(name, { authorization: parse(r[2]), transfer: parse(r[3] ?? '') })
  }
  for (const [name, want] of prose) {
    const req = REQUIRED_LEG_STATUS[name]
    const bnd = BOUNDED_LEG_STATUS[name]
    if (req === undefined && bnd === undefined) {
      // A reason with no entry is unpinned in code. That is only a fault when the
      // prose pins something, which is the case this catches.
      if (want.authorization || want.transfer) {
        fail('leg contract', `§15.4 pins "${name}" but neither leg table has an entry`)
      }
      continue
    }
    for (const leg of ['authorization', 'transfer']) {
      const p = want[leg]
      const cReq = req?.[leg] ? [...req[leg]].sort() : null
      const cBnd = bnd?.[leg] ? [...bnd[leg]].sort() : null
      const same = (a, b) => (a === null && b === null) || (a && b && a.join(',') === b.join(','))
      let ok
      if (p === null) ok = cReq === null && cBnd === null
      else if (p.required) ok = same(p.values, cReq) && cBnd === null
      else ok = same(p.values, cBnd) && cReq === null
      if (!ok) {
        const shown = p === null ? 'unpinned' : `${p.required ? 'required' : 'bounded'} ${p.values.join(' | ')}`
        const codeShown = cReq ? `required ${cReq.join(' | ')}` : cBnd ? `bounded ${cBnd.join(' | ')}` : 'unpinned'
        fail('leg contract', `${name}.${leg}: §15.4 says ${shown}, code says ${codeShown}`)
      }
    }
  }
  for (const name of new Set([...Object.keys(REQUIRED_LEG_STATUS), ...Object.keys(BOUNDED_LEG_STATUS)])) {
    if (!prose.has(name)) fail('leg contract', `a leg table has "${name}" but §15.4 has no row for it`)
  }
}

/* ------------------------------------------------------------------ *
 * 2b. The repeat settlement table: prose §5 vs REASON_SETTLEMENT
 * ------------------------------------------------------------------ */

const settleRows = tablesAfter(ext, ['reason'])
  .find((t) => t.header.some((c) => c.includes('settlement claimed')))?.rows
if (!settleRows) fail('refusal-row.md', 'no table with a "Settlement claimed" column')
else {
  const prose = new Map()
  for (const r of settleRows) {
    const name = r[1].replace(/`/g, '').trim()
    if (!/^[a-z_]+$/.test(name)) continue
    const states = (r[2].match(/`(not_submitted|pending|settled|unknown)`/g) ?? [])
      .map((m) => m.replace(/`/g, ''))
      .sort()
    prose.set(name, states.length ? states : null)
  }
  for (const [name, want] of prose) {
    const got = REASON_SETTLEMENT[name] ? [...REASON_SETTLEMENT[name]].sort() : null
    if (!want) {
      if (got) fail('repeat settlement', `§5 has no claim for "${name}" but REASON_SETTLEMENT constrains it`)
      continue
    }
    if (!got || want.join(',') !== got.join(',')) {
      fail(
        'repeat settlement',
        `${name}: §5 says ${want.join(' | ')}, code says ${got ? got.join(' | ') : 'unconstrained'}`,
      )
    }
  }
  for (const name of Object.keys(REASON_SETTLEMENT)) {
    if (!prose.has(name)) fail('repeat settlement', `REASON_SETTLEMENT constrains "${name}" but §5 has no row for it`)
  }
}

/* ------------------------------------------------------------------ *
 * 3. Ceilings: prose §5 and SPEC §5.5.2 vs REASON_CEILING
 * ------------------------------------------------------------------ */

// §5's ceiling column is the class a row may claim; the code's REASON_CEILING is
// the base ceiling before reproducibility is applied. They differ on purpose for
// `transfer_leg_failed`, so that one is compared where it is decided (§15.5).

// The prose column names what a row may claim, so the code side is the ceiling
// after reproducibility is applied — not the base ceiling, which is allowed to be
// higher for a reason whose observation no third party can attribute.
const specRows = tablesAfter(spec, ['reason', 'evidence_class']).find((t) => t.header[1] === 'reason')?.rows
if (!specRows) fail('SPEC.md', 'no table with columns "reason" and "evidence_class"')
else {
  for (const r of specRows) {
    const name = r[1].replace(/`/g, '').trim()
    const claimed = r[2].replace(/`/g, '').trim()
    if (!/^[a-z_]+$/.test(name)) continue
    if (!REASON_CEILING[name]) {
      fail('ceiling', `SPEC §5.5.2 lists "${name}" but REASON_CEILING has no entry`)
      continue
    }
    const final = reproducibleCeiling(name, ceilingFor(name)).ceiling
    if (final !== claimed) {
      fail('ceiling', `${name}: SPEC §5.5.2 says ${claimed}, the constructor can claim ${final}`)
    }
  }
}

/* ------------------------------------------------------------------ */

if (problems.length === 0) {
  console.log('docs parity: ok — the prose tables and the constructor tables agree')
  process.exit(0)
}
console.log(`docs parity: ${problems.length} disagreement(s)\n`)
for (const p of problems) console.log(`  ${p.where}: ${p.detail}`)
console.log(
  '\nA rule that lives in one place and is written in another is a rule a reader will get wrong.\n' +
  'Fix whichever side is wrong; do not silence this check.',
)
process.exit(1)
