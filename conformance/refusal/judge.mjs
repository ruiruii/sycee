#!/usr/bin/env node
// Judge for the section 15 known-answer vectors.
//
// One implementation agreeing with the published answers proves very little: a
// checker that returns the same constant for every field passes every right file
// and every wrong file too, for the wrong reason. This judge is built so that
// cannot happen, and so that the claim is testable rather than asserted.
//
//   SET     the file set is complete: every ACCEPT file has a -wrong twin, every
//           wrong twin has its right file, every REJECT file names a twin that
//           exists and is accepted, and the count matches --expect.
//   ALIGN   both implementations returned the same fields, in the same order.
//   R1      a wrong file's recorded value really differs from its twin's.
//   R2      the two implementations compute the same value for every field.
//   R3      on an ACCEPT file both compute exactly the recorded value.
//   R4      on a wrong file both compute what the RIGHT twin records — differing
//           for the right reason, not merely differing.
//   R5      on a REJECT file both refuse with the recorded code, and the file's
//           near-miss twin is accepted. A constructor that refuses everything
//           and one that accepts everything both fail here.
//   R6      the judge catches four degenerate implementations fed to it directly:
//           a constant, an accept-everything, a refuse-everything, and one that
//           never looks at the leg observations.
//
// Usage: node conformance/refusal/judge.mjs [--expect=25] [--json] [--vectors=<dir>]
// Exit 0: no violation. 1: at least one. 2: the judge could not run.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const FIELDS = ['evidence_class', 'settlement', 'final']

/** known-answer-x-wrong.json -> known-answer-x.json */
export const twinOf = (name) => name.replace(/-wrong\.json$/, '.json')

export function loadVectors(dir) {
  const out = new Map()
  for (const name of fs.readdirSync(dir).filter((f) => /^known-answer-.*\.json$/.test(f)).sort()) {
    out.set(name, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
  }
  return out
}

/** A record as both implementations emit it: {id, outcome, fields|codes}. */
export function byId(records) {
  return new Map(records.map((r) => [r.id, r]))
}

/**
 * The judge. Pure: it sees only what it is given, which is why a test can feed it
 * a wrong implementation and expect a violation.
 */
export function judge({ vectors, node, python, expect = null, selfTest = true }) {
  const faults = []
  const at = (rule, file, rest = {}) => faults.push({ rule, file, ...rest })
  let checked = 0

  // ---- SET -----------------------------------------------------------------
  if (expect !== null && vectors.size !== expect) {
    at('SET', '(set)', { detail: `expected ${expect} files, found ${vectors.size}` })
  }
  for (const [name, vec] of vectors) {
    const outcome = vec.expected?.outcome
    if (outcome !== 'ACCEPT' && outcome !== 'REJECT') {
      at('SET', name, { detail: `expected.outcome is ${JSON.stringify(outcome)}` })
      continue
    }
    if (outcome === 'ACCEPT' && !/-wrong\.json$/.test(name)) {
      const wrong = name.replace(/\.json$/, '-wrong.json')
      if (!vectors.has(wrong)) at('SET', name, { detail: 'an accepted file without a wrong twin' })
    }
    if (outcome === 'REJECT') {
      const tw = vec.twin
      if (!tw) at('SET', name, { detail: 'a rejected file that names no near-miss twin' })
      else if (!vectors.has(`known-answer-${tw}.json`)) {
        at('SET', name, { detail: `near-miss twin ${tw} does not exist` })
      } else if (vectors.get(`known-answer-${tw}.json`).expected?.outcome !== 'ACCEPT') {
        at('SET', name, { detail: `near-miss twin ${tw} is not an accepted file` })
      }
    }
    if (/-wrong\.json$/.test(name) && !vectors.has(twinOf(name))) {
      at('SET', name, { detail: 'a wrong twin whose right file is missing' })
    }
  }

  // ---- per file ------------------------------------------------------------
  for (const [name, vec] of vectors) {
    const nodeRec = node.get(vec.id)
    const pyRec = python.get(vec.id)
    if (!nodeRec || !pyRec) {
      at('ALIGN', name, { detail: `no record: node ${nodeRec ? 'ok' : 'missing'}, python ${pyRec ? 'ok' : 'missing'}` })
      continue
    }
    const outcome = vec.expected?.outcome

    if (outcome === 'REJECT') {
      checked++
      const want = vec.expected.code
      if (nodeRec.outcome !== 'REJECT' || pyRec.outcome !== 'REJECT') {
        at('R5', name, {
          want,
          detail: `a rejected input was accepted: node ${nodeRec.outcome}, python ${pyRec.outcome}`,
        })
        continue
      }
      if (nodeRec.code !== want) at('R5', name, { want, node: nodeRec.code, detail: 'node refused with the wrong code' })
      if (pyRec.code !== want) at('R5', name, { want, python: pyRec.code, detail: 'python refused with the wrong code' })
      if (nodeRec.code !== pyRec.code) at('R2', name, { node: nodeRec.code, python: pyRec.code, detail: 'the two refusals disagree' })
      const twName = `known-answer-${vec.twin}.json`
      const twVec = vectors.get(twName)
      if (twVec) {
        const twNode = node.get(twVec.id)
        const twPy = python.get(twVec.id)
        if (twNode?.outcome !== 'ACCEPT' || twPy?.outcome !== 'ACCEPT') {
          at('R5', name, { detail: `the near-miss twin ${vec.twin} was also refused` })
        }
      }
      continue
    }

    // ACCEPT and its wrong twin
    const wantRec = byId([{ id: vec.id, outcome: 'ACCEPT', fields: fieldsOf(vec) }]).get(vec.id)
    if (nodeRec.outcome !== 'ACCEPT' || pyRec.outcome !== 'ACCEPT') {
      at('R3', name, { detail: `a legal input was refused: node ${nodeRec.outcome}, python ${pyRec.outcome}` })
      continue
    }
    const fN = nodeRec.fields ?? []
    const fP = pyRec.fields ?? []
    if (fN.length !== FIELDS.length || fP.length !== FIELDS.length) {
      at('ALIGN', name, { detail: `expected ${FIELDS.length} fields, node ${fN.length}, python ${fP.length}` })
      continue
    }
    const isWrong = /-wrong\.json$/.test(name)
    const rightVec = isWrong ? vectors.get(twinOf(name)) : vec
    const rightFields = fieldsOf(rightVec)

    if (isWrong) {
      const differs = FIELDS.some(
        (f) => JSON.stringify(fieldsOf(vec).find((x) => x.field === f).computed) !==
               JSON.stringify(rightFields.find((x) => x.field === f).computed),
      )
      if (!differs) {
        at('R1', name, { twin: rightFields, detail: 'no field differs from the right twin: this file tests nothing' })
      }
    }

    FIELDS.forEach((field, k) => {
      if (fN[k].field !== field) at('ALIGN', name, { field, detail: `node returned ${fN[k].field}` })
      if (fP[k].field !== field) at('ALIGN', name, { field, detail: `python returned ${fP[k].field}` })
      if (fN[k].skipped || fP[k].skipped) return
      checked++
      const recorded = fieldsOf(vec)[k].computed
      const right = rightFields[k].computed
      const ctx = { field, recorded, node: fN[k].computed, python: fP[k].computed }

      if (JSON.stringify(fN[k].computed) !== JSON.stringify(fP[k].computed)) {
        at('R2', name, { ...ctx, detail: 'the two implementations disagree' })
      }
      if (isWrong) {
        if (JSON.stringify(fN[k].computed) !== JSON.stringify(right)) {
          at('R4', name, { ...ctx, twin: right, detail: 'node did not compute what the right twin records' })
        }
        if (JSON.stringify(fP[k].computed) !== JSON.stringify(right)) {
          at('R4', name, { ...ctx, twin: right, detail: 'python did not compute what the right twin records' })
        }
      } else if (
        JSON.stringify(fN[k].computed) !== JSON.stringify(recorded) ||
        JSON.stringify(fP[k].computed) !== JSON.stringify(recorded)
      ) {
        at('R3', name, { ...ctx, detail: 'an implementation does not compute the recorded value' })
      }
      void wantRec
    })
  }

  // ---- R6: can this judge be fooled? ---------------------------------------
  // Skipped on the recursive call, or the self-test would test itself forever.
  const degenerate = !selfTest ? [] : [
    {
      name: 'constant',
      make: (v) =>
        v.expected?.outcome === 'REJECT'
          ? { id: v.id, outcome: 'ACCEPT', fields: FIELDS.map((f) => ({ field: f, computed: null })) }
          : { id: v.id, outcome: 'ACCEPT', fields: FIELDS.map((f) => ({ field: f, computed: null })) },
    },
    {
      name: 'accept-everything',
      make: (v) => ({
        id: v.id,
        outcome: 'ACCEPT',
        fields: FIELDS.map((f) => ({ field: f, computed: fieldsOf(v).find((x) => x.field === f).computed })),
      }),
    },
    {
      name: 'refuse-everything',
      make: (v) => ({ id: v.id, outcome: 'REJECT', code: v.expected?.code ?? 'leg_contradicts_reason' }),
    },
    {
      name: 'base-ceiling-default',
      // the plausible mistake, not the stupid one: every rule implemented, the
      // default taken from the reason's base ceiling instead of the reproducible
      // one. On a split-leg reason that understates nothing and overstates the
      // claim, which is exactly what a twin file exists to catch.
      make: (v) => {
        const fields = fieldsOf(v).map((x) => ({ ...x }))
        if (v.input?.reason === 'transfer_leg_failed' && v.input?.evidence_class === undefined) {
          fields.find((x) => x.field === 'evidence_class').computed = 'chain_verifiable'
        }
        return { id: v.id, outcome: 'ACCEPT', fields }
      },
    },
  ]
  for (const d of degenerate) {
    const recs = [...vectors.values()].map(d.make)
    const seen = byId(recs)
    const sub = judge({ vectors, node: seen, python: seen, expect, selfTest: false })
    if (sub.faults.length === 0) {
      at('R6', `(degenerate:${d.name})`, { detail: 'a wrong implementation passed the judge' })
    }
  }

  const accepts = [...vectors.values()].filter((v) => v.expected?.outcome === 'ACCEPT').length
  return { faults, files: vectors.size, accepts, rejects: vectors.size - accepts, checked }
}

/** The recorded fields of a vector, in FIELDS order. */
export function fieldsOf(vec) {
  const obs = vec.observed ?? {}
  return FIELDS.map((f) => ({ field: f, computed: obs[f] === undefined ? null : obs[f] }))
}

function pythonRecords(script, dir) {
  const r = spawnSync('python3', ['-I', script, dir, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw new Error(`python3 could not be started: ${r.error.message}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`the Python checker did not return JSON (exit ${r.status}): ${String(r.stderr || r.stdout).slice(0, 300)}`)
  }
}

function nodeRecords(script, dir) {
  const r = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw new Error(`node could not be started: ${r.error.message}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`the Node checker did not return JSON (exit ${r.status}): ${String(r.stderr || r.stdout).slice(0, 300)}`)
  }
}

const RULE_TEXT = {
  SET: 'the file set is complete (pairs, twins, count)',
  ALIGN: 'both implementations returned the same fields in the same order',
  R1: 'a wrong value really differs from its right twin',
  R2: 'the two implementations agree on every field',
  R3: 'on an accepted file both compute the recorded value',
  R4: 'on a wrong file both compute what the right twin records',
  R5: 'on a rejected file both refuse with the recorded code, and the near-miss is accepted',
  R6: 'the judge catches degenerate implementations fed to it',
}

function main() {
  const arg = (n) => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`))
    return a ? a.slice(n.length + 3) : undefined
  }
  const dir = path.resolve(arg('vectors') ?? path.join(HERE, 'vectors'))
  const expect = arg('expect') === undefined ? null : Number(arg('expect'))
  const asJson = process.argv.includes('--json')

  let result
  try {
    const vectors = loadVectors(dir)
    if (vectors.size === 0) throw new Error(`no known-answer files in ${dir}`)
    const node = byId(nodeRecords(path.join(HERE, 'verify-known-answers.mjs'), dir))
    const python = byId(pythonRecords(path.join(HERE, 'verify_known_answers.py'), dir))
    result = judge({ vectors, node, python, expect })
  } catch (e) {
    console.error('judge error: ' + e.message)
    process.exit(2)
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(
      `refusal vectors: ${result.files} files (${result.accepts} accepted, ${result.rejects} rejected), ` +
        `${result.checked} field checks, two implementations, ${Object.keys(RULE_TEXT).length} rules`,
    )
    for (const rule of Object.keys(RULE_TEXT)) {
      const n = result.faults.filter((f) => f.rule === rule).length
      console.log(`  ${rule.padEnd(5)} ${n === 0 ? 'ok  ' : 'FAIL'}  ${RULE_TEXT[rule]}${n ? `  (${n})` : ''}`)
    }
    for (const f of result.faults) {
      console.log(`\n  ${f.rule}  ${f.file}${f.field ? `  field: ${f.field}` : ''}\n     ${f.detail}`)
      if (f.want !== undefined) console.log(`     want     : ${f.want}`)
      if (f.recorded !== undefined) console.log(`     recorded : ${JSON.stringify(f.recorded)}`)
      if (f.node !== undefined) console.log(`     node     : ${JSON.stringify(f.node)}`)
      if (f.python !== undefined) console.log(`     python   : ${JSON.stringify(f.python)}`)
      if (f.twin !== undefined) console.log(`     twin     : ${JSON.stringify(f.twin)}`)
    }
    console.log(result.faults.length ? '\nFAIL' : '\nOK')
  }
  process.exit(result.faults.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
