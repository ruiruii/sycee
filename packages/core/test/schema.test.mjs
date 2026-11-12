import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = fileURLToPath(new URL('../..', import.meta.url));

test('shipped schema is identical to the canonical schema', () => {
  const shipped = readFileSync(new URL('../src/vsr-v0.1.schema.json', import.meta.url), 'utf8');
  const canonical = readFileSync(new URL('../../../schema/vsr-v0.1.schema.json', import.meta.url), 'utf8');
  assert.equal(shipped, canonical);
});

/**
 * `files` is a whitelist. An export, bin, or main that points outside the
 * package, or at a path the whitelist omits, is missing from the published tarball.
 */
function entryTargets(pkg) {
  const targets = [];
  if (typeof pkg.main === 'string') targets.push(['main', pkg.main]);
  if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
    for (const [key, value] of Object.entries(pkg.exports)) {
      if (typeof value === 'string') targets.push([`exports["${key}"]`, value]);
    }
  }
  if (typeof pkg.bin === 'string') targets.push(['bin', pkg.bin]);
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [key, value] of Object.entries(pkg.bin)) {
      if (typeof value === 'string') targets.push([`bin["${key}"]`, value]);
    }
  }
  return targets;
}

function includedInFiles(relPath, files) {
  const norm = relPath.replace(/^\.\//, '');
  return files.some((entry) => {
    const prefix = entry.replace(/^\.\//, '').replace(/\/$/, '');
    return norm === prefix || norm.startsWith(`${prefix}/`);
  });
}

test('every @sycee package entry point is inside the package and listed in files', () => {
  const names = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.ok(names.includes('core'));

  for (const name of names) {
    const dir = join(packagesDir, name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, `${pkg.name} must set files`);

    for (const [label, target] of entryTargets(pkg)) {
      assert.equal(target.includes('..'), false, `${pkg.name} ${label} points outside the package: ${target}`);
      const rel = target.replace(/^\.\//, '');
      const abs = join(dir, rel);
      assert.equal(statSync(abs).isFile(), true, `${pkg.name} ${label} does not resolve to a file: ${target}`);
      assert.equal(
        includedInFiles(rel, pkg.files),
        true,
        `${pkg.name} ${label} is not covered by files: ${target}`,
      );
    }
  }

  const core = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(core.exports['./schema'], './src/vsr-v0.1.schema.json');
});
