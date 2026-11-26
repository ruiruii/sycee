import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// The vectors exist twice on purpose: once as the conformance source of truth,
// once bundled into the published CLI so a reader can check us without cloning.
// Two copies drift unless something fails when they do, so this is that thing.
const here = fileURLToPath(new URL('.', import.meta.url));
const bundled = join(here, '..', 'vectors');
const source = join(here, '..', '..', '..', 'conformance', 'refusal', 'vectors');

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('the bundled vectors are byte-identical to the conformance source', () => {
  const a = readdirSync(source).filter((n) => n.endsWith('.json')).sort();
  const b = readdirSync(bundled).filter((n) => n.endsWith('.json')).sort();

  assert.deepEqual(b, a, 'the bundled set must name exactly the same files');
  for (const name of a) {
    assert.equal(
      digest(join(bundled, name)),
      digest(join(source, name)),
      `${name} differs between the two copies — regenerate the bundle, do not edit it`,
    );
  }
});

test('the bundled set is the full set, not a sample', () => {
  const files = readdirSync(bundled).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 76, 'a partial bundle would let a reader pass without being checked');
});
