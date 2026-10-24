import { randomUUID } from 'node:crypto';
import { test, expect, request as apiRequestFactory } from '@playwright/test';
import { TEST_ADDRESSES } from '../src/test-data/addresses.ts';

// These tests document CURRENT observed behavior of the live API for a
// handful of negative/edge inputs — they are not asserting against a
// published spec (none exists for this API), so a future intentional API
// change could legitimately require updating these, not just a regression.
// Only inputs that produced a stable, deterministic response during
// discovery are covered here — see README "Negative and edge cases" for
// the full discovery notes, including one case (missing Authorization
// header) that was deliberately asserted more loosely than the rest.
test.describe('Negative and edge cases', () => {
    test('missing Authorization header is rejected before reaching the app', async () => {
        // Playwright Test applies the config's `use` options — including
        // extraHTTPHeaders — as defaults to EVERY APIRequestContext created
        // during a run, even ones built from this standalone factory rather
        // than the `request` fixture. Without extraHTTPHeaders: {} below,
        // this "missing header" request would silently still carry the
        // Authorization header configured in playwright.config.ts, making
        // the test assert nothing meaningful (confirmed directly: omitting
        // this option here sent the configured Authorization anyway).
        const noAuthContext = await apiRequestFactory.newContext({
            baseURL: 'https://wallet-api.solflare.com',
            extraHTTPHeaders: {}
        });

        try {
            const response = await noAuthContext.get(`/v3/portfolio/tokens/${TEST_ADDRESSES[0]}`, {
                params: { network: 'mainnet' }
            });

            // Cloudflare's own edge/WAF intercepts this before Solflare's
            // application ever sees the request, returning an HTML
            // challenge page rather than an app-level error — confirmed by
            // repeated manual probing during discovery (see README). That
            // HTML is Cloudflare's, not the app's, and isn't guaranteed to
            // look the same from a different IP (e.g. a CI runner), so this
            // deliberately asserts nothing about the response body's
            // content — only that the request was rejected, and rejected
            // for an auth reason specifically rather than some unrelated
            // server error that would also happen to not be 2xx.
            expect([401, 403]).toContain(response.status());

            const body = await response.text();
            let looksLikePortfolioData = false;
            try {
                const parsed = JSON.parse(body);
                looksLikePortfolioData =
                    typeof parsed === 'object' && parsed !== null && ('value' in parsed || 'tokens' in parsed);
            } catch {
                // Not JSON at all (e.g. Cloudflare's HTML challenge page) —
                // already not portfolio data.
            }
            expect(looksLikePortfolioData, 'response body should not contain portfolio data when unauthenticated').toBe(
                false
            );
        } finally {
            await noAuthContext.dispose();
        }

        // Positive control: the same kind of isolated context, differing
        // only in carrying a valid Bearer, DOES get through with real data.
        // This proves the 403 above is caused specifically by the missing
        // Authorization header, not by something else about an isolated
        // context (e.g. a different default header set) that Cloudflare
        // might also be reacting to.
        const authedContext = await apiRequestFactory.newContext({
            baseURL: 'https://wallet-api.solflare.com',
            extraHTTPHeaders: { Authorization: `Bearer ${randomUUID()}` }
        });

        try {
            const response = await authedContext.get(`/v3/portfolio/tokens/${TEST_ADDRESSES[0]}`, {
                params: { network: 'mainnet' }
            });

            expect(response.status()).toBe(200);
            expect(await response.json()).toHaveProperty('tokens');
        } finally {
            await authedContext.dispose();
        }
    });

    test('malformed (non-uuid) bearer value is rejected by the app', async ({ request }) => {
        const response = await request.get(`/v3/portfolio/tokens/${TEST_ADDRESSES[0]}`, {
            params: { network: 'mainnet' },
            headers: { Authorization: 'Bearer not-a-uuid' }
        });

        // Unlike the missing-header case, this reaches the application
        // itself — a clean, deterministic plain-text response, not HTML.
        expect(response.status()).toBe(403);
        expect(await response.text()).toContain('Invalid API key!');
    });

    test('invalid address returns a validation error', async ({ request }) => {
        const response = await request.get('/v3/portfolio/tokens/not-a-real-address', {
            params: { network: 'mainnet' }
        });

        expect(response.status()).toBe(400);
        const body = await response.json();
        expect(body).toMatchObject({ type: 'HttpValidationError', code: 400 });
        expect(body.message).toContain('Invalid public key');
    });

    test('unsupported network value returns a validation error', async ({ request }) => {
        const response = await request.get(`/v3/portfolio/tokens/${TEST_ADDRESSES[0]}`, {
            params: { network: 'foobar' }
        });

        expect(response.status()).toBe(400);
        const body = await response.json();
        expect(body).toMatchObject({ type: 'HttpValidationError', code: 400 });
        expect(body.message).toContain('must be one of');
    });

    test('empty pubkeys array on balances returns a zeroed portfolio, not an error', async ({ request }) => {
        const response = await request.post('/v2/portfolio/balances', {
            data: { pubkeys: [], currency: 'usd', general: true, network: 'mainnet' }
        });

        // Documented current behavior: this is a 200, not a 400 — an empty
        // wallet list is treated as a valid (trivially empty) portfolio.
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ netWorth: 0, netWorthChange: 0, data: [] });
    });
});
