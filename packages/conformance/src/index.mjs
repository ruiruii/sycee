/**
 * Combined conformance entry point: JSON Schema validation + semantic verification.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { validateInstance } from './validate.mjs';
import { verifyVSR, toSpanAttributes } from '@sycee/core';

const require = createRequire(import.meta.url);

/** Load the VSR JSON Schema shipped on `@sycee/core/schema`. */
export function loadSchema() {
  return JSON.parse(readFileSync(require.resolve('@sycee/core/schema'), 'utf8'));
}

/**
 * Full conformance check of a VSR envelope.
 * @param {unknown} envelope
 * @returns {{
 *   valid: boolean,
 *   schemaValid: boolean,
 *   signatureValid: boolean,
 *   level: string,
 *   schemaErrors: string[],
 *   semanticErrors: string[],
 *   warnings: string[],
 *   spanAttributes: Record<string, unknown>
 * }}
 */
export function checkEnvelope(envelope) {
  const schema = loadSchema();
  const schemaErrors = validateInstance(envelope, schema);
  const semantic = verifyVSR(envelope);

  const signatureValid =
    !semantic.errors.some((e) => e.startsWith('signature')) &&
    typeof /** @type {any} */ (envelope)?.signature === 'string';

  return {
    valid: schemaErrors.length === 0 && semantic.valid,
    schemaValid: schemaErrors.length === 0,
    signatureValid,
    level: semantic.level,
    schemaErrors,
    semanticErrors: semantic.errors,
    warnings: semantic.warnings,
    spanAttributes: envelope && typeof envelope === 'object' && 'vsr' in envelope
      ? toSpanAttributes(/** @type {any} */ (envelope).vsr)
      : {},
  };
}

export { validateInstance, verifyVSR, toSpanAttributes };
