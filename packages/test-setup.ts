/**
 * Test setup preload -- isolate test state from production and set the
 * default test/hook timeout.
 *
 * Sets ARK_TEST_DIR for code paths that read it directly instead of going
 * through AppContext. Tests using AppContext.forTest() create their own
 * isolated temp dir and get full isolation via app.boot() + app.shutdown().
 */

import { setDefaultTimeout } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// `make test` runs `bun test --concurrency 4`. The Temporal test-harness
// lifecycle hooks are genuinely heavy under that contention -- `app.boot()`
// bundles a napi Temporal worker and `drainTemporalTestHarness()` awaits
// real poll-driven activities -- so they intermittently blow bun's 5s
// default and surface as "beforeEach/afterEach hook timed out". Raise the
// default (tests + hooks) to a ceiling that covers the legitimate cost yet
// stays well under the 180s per-case budget the e2e suites set explicitly,
// so a true hang still fails fast rather than being masked.
setDefaultTimeout(30_000);

if (!process.env.ARK_TEST_DIR) {
  const testDir = mkdtempSync(join(tmpdir(), "ark-test-"));
  process.env.ARK_TEST_DIR = testDir;
  process.env.NODE_ENV = "test";
}
