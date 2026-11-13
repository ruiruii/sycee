#!/usr/bin/env node
/**
 * A subdirectory `npm install` (Railway's root directory is
 * examples/demo-merchant) installs this package, but @sycee/agent-sdk and
 * @sycee/middleware live in the repo and import `@sycee/core` from their own
 * folders. Node resolves that import from those folders, not from this
 * package's node_modules. Point them at packages/core.
 *
 * The repo-root workspace install already links the same packages. Replacing
 * a symlink is safe. A real directory is left alone.
 */

import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const core = path.join(repo, 'packages', 'core');
const consumers = ['agent-sdk', 'middleware'];

for (const name of consumers) {
  const link = path.join(repo, 'packages', name, 'node_modules', '@sycee', 'core');
  await mkdir(path.dirname(link), { recursive: true });
  let existing = null;
  try {
    existing = await lstat(link);
  } catch {
    existing = null;
  }
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing?.isSymbolicLink()) {
    const current = path.resolve(path.dirname(link), await readlink(link));
    if (current === core) continue;
    await rm(link);
  }
  const rel = path.relative(path.dirname(link), core);
  await symlink(rel, link, 'dir');
}
