#!/usr/bin/env node
// Known-answer checker for the section 15 refusal-row vectors.
//
// Reads every known-answer-*.json in a directory and reports, per file, either
// the fields an honest constructor computes or the code it refuses with. The
// report is only useful to a judge that also has a second implementation: one
// implementation agreeing with itself proves nothing.
//
// Usage: node conformance/refusal/verify-known-answers.mjs [dir] [--json]
// Exit 0 when every file was read (not when every file is right — that is the
// judge's job). Exit 2 when the checker itself could not run.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { refusalRow } from '../../packages/core/src/refusal.mjs'

/** The fields a vector asks about, in the order it asks. */
export const FIELDS = ['evidence_class', 'settlement', 'final']

/**
 * The constructor speaks in messages; the vectors speak in codes. This is the
 * only place the two vocabularies meet, and it is deliberately small: a code
 * that is not listed here is `unclassified`, never silently dropped.
 */
export function codeOf(message) {
  if (/is not reproducible/.test(message)) return 'not_reproducible'
  const m = /^refusalRow: ([a-z_]+) —/.exec(message)
  return m ? m[1] : `unclassified: ${message.slice(0, 80)}`
}

/** Build the row input from a vector. Absent keys are absent, not undefined. */
function inputOf(vec) {
  const v = vec.input
  const out = {
    decision: v.decision,
    attemptIdentity: v.attempt_identity,
    signingPublicKey: v.signing_public_key,
  }
  if (v.reason !== undefined) out.reason = v.reason
  if (v.legs !== undefined) out.legs = v.legs
  if (v.settlement !== undefined) out.settlement = v.settlement
  if (v.final !== undefined) out.final = v.final
  // A vector that asks for a class names it; one that asks what the default is
  // says nothing, and the default must then be the answer.
  if (v.evidence_class !== undefined) out.evidenceClass = v.evidence_class
  // Fixed so two runs compare equal; the vectors do not test the clock.
  out.observedAt = '2026-11-20T00:00:00.000Z'
  return out
}

/** What this implementation computes for one vector. */
export function compute(vec) {
  try {
    const row = refusalRow(inputOf(vec))
    const fields = FIELDS.map((f) => ({
      field: f,
      computed: row[f] === undefined ? null : row[f],
    }))
    return { id: vec.id, outcome: 'ACCEPT', fields }
  } catch (e) {
    return { id: vec.id, outcome: 'REJECT', code: codeOf(String(e.message)) }
  }
}

export function loadVectors(dir) {
  const out = new Map()
  for (const name of fs.readdirSync(dir).filter((f) => /^known-answer-.*\.json$/.test(f)).sort()) {
    out.set(name, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
  }
  return out
}

function main() {
  const asJson = process.argv.includes('--json')
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const dir = path.resolve(
    args[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors'),
  )
  const vectors = loadVectors(dir)
  if (vectors.size === 0) {
    console.error(`no known-answer files in ${dir}`)
    process.exit(2)
  }
  const records = [...vectors.values()].map(compute)
  if (asJson) {
    console.log(JSON.stringify(records))
    return
  }
  for (const r of records) {
    if (r.outcome === 'REJECT') {
      console.log(`${r.id.padEnd(48)} REJECT ${r.code}`)
    } else {
      const shown = r.fields
        .map((f) => `${f.field}=${f.computed === null ? 'null' : JSON.stringify(f.computed)}`)
        .join(' ')
      console.log(`${r.id.padEnd(48)} ACCEPT ${shown}`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
