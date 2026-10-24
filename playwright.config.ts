import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// One uuid4 per test run, simulating a single app install. Generated here
// (not per-test) because every request in the run should look like it came
// from the same install, and because extraHTTPHeaders is applied once for
// the whole run rather than wired through a per-test fixture.
const appInstallId = randomUUID();
console.log(`[solflare-api-tests] app install id for this run: ${appInstallId}`);

export default defineConfig({
    testDir: './tests',

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
