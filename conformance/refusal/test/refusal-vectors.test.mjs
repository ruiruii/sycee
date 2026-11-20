// Tests for the section 15 known-answer judge.
//
// Two kinds of test. The first asks whether the real pair of implementations
// agrees with the files. The second asks whether the judge can be fooled — fed a
// wrong implementation directly, does it say so, and does it say so with the rule
// that names the actual defect? A judge that only passes the good case has not
// been tested; it has been run.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { judge, loadVectors, byId, fieldsOf, FIELDS } from '../judge.mjs'
import { compute as computeNode } from '../verify-known-answers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = path.join(HERE, '..', 'vectors')

const vectors = loadVectors(VECTORS)

/** A record that claims the recorded answer for every file: the cheat. */
const recorded = (v) => ({
  id: v.id,
  outcome: 'ACCEPT',
  fields: fieldsOf(v),
})

/** A record that returns one constant for every field: the degenerate case. */
const constant = (v) => ({
  id: v.id,
  outcome: 'ACCEPT',
  fields: FIELDS.map((f) => ({ field: f, computed: f === 'evidence_class' ? 'issuer_asserted' : null })),
})

/** A record that refuses everything, with whatever code the vector wanted. */
const refuser = (v) => ({ id: v.id, outcome: 'REJECT', code: v.expected?.code ?? 'leg_contradicts_reason' })

/** The plausible mistake: right rules, wrong default. */
const baseCeiling = (v) => {
  const fields = fieldsOf(v).map((x) => ({ ...x }))
  if (v.input?.reason === 'transfer_leg_failed' && v.input?.evidence_class === undefined) {
    fields.find((x) => x.field === 'evidence_class').computed = 'chain_verifiable'
  }
  return { id: v.id, outcome: 'ACCEPT', fields }
}

/** Judge one implementation against itself, so only the file contract is tested. */
const judgeSelf = (make) => {
  const m = byId([...vectors.values()].map(make))
  return judge({ vectors, node: m, python: m, expect: vectors.size, selfTest: false })
}

test('the file set is paired: every accepted file has a wrong twin, every rejected file a near miss', () => {
  const r = judge({ vectors, node: new Map(), python: new Map(), expect: vectors.size, selfTest: false })
  const setFaults = r.faults.filter((f) => f.rule === 'SET')
  assert.deepEqual(setFaults, [], 'the set itself is malformed, so nothing below it is meaningful')
})

test('a constant implementation is caught, and caught on the files it should fail', () => {
  const r = judgeSelf(constant)
  assert.ok(r.faults.length > 0, 'a checker returning one value for everything passed')
  const rules = new Set(r.faults.map((f) => f.rule))
  assert.ok(rules.has('R3'), 'a constant got past the accepted files')
})

test('an implementation that copies the recorded answer is caught on the reject files', () => {
  const r = judgeSelf(recorded)
  assert.ok(r.faults.length > 0, 'accepting every input passed the judge')
  assert.ok(
    r.faults.some((f) => f.rule === 'R5'),
    'accepting every input should fail the rule that requires a refusal',
  )
})

test('an implementation that refuses everything is caught on the accepted files', () => {
  const r = judgeSelf(refuser)
  assert.ok(r.faults.length > 0, 'refusing every input passed the judge')
  assert.ok(r.faults.some((f) => f.rule === 'R3'), 'refusing everything should fail on an accepted file')
})

test('the plausible mistake — base ceiling as the default — is caught by the twin rule', () => {
  const r = judgeSelf(baseCeiling)
  const twinFaults = r.faults.filter((f) => f.rule === 'R4')
  assert.ok(
    twinFaults.length > 0,
    'taking the split-leg reason\'s base ceiling as the default passed: the twin rule did not bite',
  )
  // and it must bite on the file that exists for this exact mistake
  assert.ok(twinFaults.some((f) => f.file.includes('permit2-transfer-reverted')))
})

test('a judge handed two implementations that disagree says so, rather than picking one', () => {
  const right = byId([...vectors.values()].map(recorded))
  const other = byId([...vectors.values()].map(constant))
  const r = judge({ vectors, node: right, python: other, expect: vectors.size, selfTest: false })
  assert.ok(r.faults.some((f) => f.rule === 'R2'), 'a disagreement between the two implementations went unreported')
})

test('a wrong file whose value equals its twin is rejected as testing nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-'))
  for (const [name, vec] of vectors) {
    fs.writeFileSync(path.join(tmp, name), JSON.stringify(vec))
  }
  // make one wrong twin identical to its right file: the pair now tests nothing
  const v = vectors.get('known-answer-permit2-transfer-reverted-wrong.json')
  const near = { ...v, observed: { ...v.observed, evidence_class: 'issuer_asserted' } }
  const twin = vectors.get('known-answer-permit2-transfer-reverted.json')
  near.observed = { ...twin.observed }
  fs.writeFileSync(path.join(tmp, 'known-answer-permit2-transfer-reverted-wrong.json'), JSON.stringify(near))

  const vv = loadVectors(tmp)
  const m = byId([...vv.values()].map(recorded))
  const r = judge({ vectors: vv, node: m, python: m, expect: vv.size, selfTest: false })
  assert.ok(r.faults.some((f) => f.rule === 'R1'), 'a wrong file equal to its twin was accepted as a test')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a file set missing a right twin is caught by the set rule', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-'))
  for (const [name, vec] of vectors) {
    if (name === 'known-answer-permit2-transfer-reverted.json') continue
    fs.writeFileSync(path.join(tmp, name), JSON.stringify(vec))
  }
  const vv = loadVectors(tmp)
  const r = judge({ vectors: vv, node: new Map(), python: new Map(), expect: vv.size, selfTest: false })
  assert.ok(r.faults.some((f) => f.rule === 'SET'), 'a lone wrong twin without its right file passed the set check')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the Node checker refuses the right code for every rejected vector', () => {
  for (const [name, vec] of vectors) {
    if (vec.expected?.outcome !== 'REJECT') continue
    const got = computeNode(vec)
    assert.equal(got.outcome, 'REJECT', `${name} was accepted`)
    assert.equal(got.code, vec.expected.code, `${name} refused with ${got.code}`)
  }
})

test('the Node checker answers every accepted vector with the recorded value', () => {
  for (const [name, vec] of vectors) {
    // a -wrong file records a wrong answer on purpose; its value is the twin's
    if (vec.expected?.outcome !== 'ACCEPT' || /-wrong\.json$/.test(name)) continue
    const got = computeNode(vec)
    assert.equal(got.outcome, 'ACCEPT', `${name} was refused`)
    for (const f of FIELDS) {
      assert.deepEqual(
        got.fields.find((x) => x.field === f).computed,
        vec.observed[f] === undefined ? null : vec.observed[f],
        `${name} field ${f}`,
      )
    }
  }
})
