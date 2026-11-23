#!/usr/bin/env node
/**
 * Local shim. The implementation lives in the publishable `sycee-verify`
 * package (packages/cli/bin/sycee-verify.mjs); this forwarder keeps the
 * repository's existing paths (`npm run try`, `README`, contributors) working
 * without a second copy of the logic.
 */
import '../packages/cli/bin/sycee-verify.mjs';
