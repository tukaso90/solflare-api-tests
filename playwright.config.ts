import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// One uuid4 per test run, simulating a single app install. Generated here
// (not per-test) because every request in the run should look like it came
// from the same install, and because extraHTTPHeaders is applied once for
// the whole run rather than wired through a per-test fixture.
const appInstallId = randomUUID();

// This module is imported twice: once by Playwright's main/orchestrator
// process (to plan the run — worker count, reporters, etc. — it never
// sends any HTTP request itself) and once by the single worker process
// that actually runs the tests and owns the `request` fixture. Logging
// unconditionally would print two different (and equally real-looking)
// UUIDs, even though only the worker's is ever sent in a request.
// TEST_WORKER_INDEX is set by Playwright only inside worker processes, so
// this guard makes the log fire exactly once, from the process whose UUID
// is the one that matters.
if (process.env.TEST_WORKER_INDEX !== undefined) {
    console.log(`[solflare-api-tests] app install id for this run: ${appInstallId}`);
}

export default defineConfig({
    testDir: './tests',

    // Playwright Test re-evaluates this config file per worker process, so
    // with more than one worker, each would generate its own appInstallId
    // above — breaking the "one uuid4 simulates one app install" premise
    // and making "trace a run by its UUID" ambiguous. The suite is small
    // enough (a handful of tests, a couple of seconds) that forcing a
    // single worker costs effectively nothing.
    workers: 1,

    // Live prices mean a scenario can occasionally fail on real price
    // movement between the GET and POST calls, not a code defect — see
    // README. Retried once in CI to absorb that; not locally, so a real
    // bug doesn't masquerade as a flake while iterating.
    retries: process.env.CI ? 1 : 0,

    reporter: [
        ['list'],
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'test-results/junit.xml' }]
    ],

    use: {
        baseURL: 'https://wallet-api.solflare.com',
        extraHTTPHeaders: {
            Authorization: `Bearer ${appInstallId}`
        }
    }
});
