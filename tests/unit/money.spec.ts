import { test, expect } from '@playwright/test';
import { assertMoneyClose, assertTruncatedTo, type Tolerance } from '../../src/utils/money.ts';

// Pure unit tests for the money helpers — no network, no `request` fixture.
// These run as part of the same `npm test` invocation as the API tests
// (both live under playwright.config.ts's testDir), just without hitting
// the network.

test.describe('assertMoneyClose', () => {
    test('passes on exact equality', () => {
        expect(() => assertMoneyClose(10, 10, { absolute: 0, relative: 0 }, 'label')).not.toThrow();
    });

    test('passes within absolute tolerance', () => {
        const tolerance: Tolerance = { absolute: 0.5, relative: 0 };
        expect(() => assertMoneyClose(10.5, 10, tolerance, 'label')).not.toThrow();
    });

    test('passes within relative tolerance', () => {
        // 1% of 1000 = 10, so 1009 is within tolerance of 1000.
        const tolerance: Tolerance = { absolute: 0, relative: 0.01 };
        expect(() => assertMoneyClose(1009, 1000, tolerance, 'label')).not.toThrow();
    });

    test('throws with a descriptive message just outside tolerance', () => {
        const tolerance: Tolerance = { absolute: 0.5, relative: 0 };
        let thrown: unknown;
        try {
            assertMoneyClose(10.51, 10, tolerance, 'my comparison');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain('my comparison');
        expect(message).toContain('expected');
        expect(message).toContain('10');
        expect(message).toContain('actual');
        expect(message).toContain('10.51');
        expect(message).toContain('difference');
    });

    test('throws when actual is NaN', () => {
        expect(() => assertMoneyClose(NaN, 10, { absolute: 1, relative: 0 }, 'label')).toThrow(/finite/);
    });

    test('throws when expected is NaN', () => {
        expect(() => assertMoneyClose(10, NaN, { absolute: 1, relative: 0 }, 'label')).toThrow(/finite/);
    });

    test('throws when actual is Infinity', () => {
        expect(() => assertMoneyClose(Infinity, 10, { absolute: 1, relative: 0 }, 'label')).toThrow(/finite/);
    });

    test('throws when expected is Infinity', () => {
        expect(() => assertMoneyClose(10, Infinity, { absolute: 1, relative: 0 }, 'label')).toThrow(/finite/);
    });

    test('throws when tolerance.absolute is negative', () => {
        expect(() => assertMoneyClose(10, 10, { absolute: -1, relative: 0 }, 'label')).toThrow(/non-negative/);
    });

    test('throws when tolerance.relative is negative', () => {
        expect(() => assertMoneyClose(10, 10, { absolute: 0, relative: -0.01 }, 'label')).toThrow(/non-negative/);
    });

    test('throws when tolerance.absolute is not finite', () => {
        expect(() => assertMoneyClose(10, 10, { absolute: Infinity, relative: 0 }, 'label')).toThrow(/finite/);
    });

    test('throws when tolerance.relative is NaN', () => {
        expect(() => assertMoneyClose(10, 10, { absolute: 0, relative: NaN }, 'label')).toThrow(/finite/);
    });
});

test.describe('assertTruncatedTo', () => {
    test('passes when actual is expected truncated down to decimals', () => {
        // Mirrors the live SPYX case from README Finding #2.
        expect(() => assertTruncatedTo(0.00310096, 0.0031009699894586212, 8, 'label')).not.toThrow();
    });

    test('fails when actual is rounded up instead of truncated', () => {
        expect(() => assertTruncatedTo(0.00310097, 0.0031009699894586212, 8, 'label')).toThrow();
    });

    test('fails when actual is a full unit lower than expected', () => {
        // decimals: 0 keeps the unit (1) and the arithmetic exact, so this
        // isolates the "one full unit below" boundary from float noise.
        expect(() => assertTruncatedTo(1, 2, 0, 'label')).toThrow();
    });

    test('passes on exact equality', () => {
        expect(() => assertTruncatedTo(5, 5, 2, 'label')).not.toThrow();
    });

    test('throws with a descriptive message naming expected/actual/difference', () => {
        let thrown: unknown;
        try {
            assertTruncatedTo(1, 2, 0, 'my truncation check');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain('my truncation check');
        expect(message).toContain('expected');
        expect(message).toContain('actual');
        expect(message).toContain('difference');
    });

    test('throws when actual is NaN', () => {
        expect(() => assertTruncatedTo(NaN, 5, 2, 'label')).toThrow(/finite/);
    });

    test('throws when expected is Infinity', () => {
        expect(() => assertTruncatedTo(5, Infinity, 2, 'label')).toThrow(/finite/);
    });

    test('throws when decimals is negative', () => {
        expect(() => assertTruncatedTo(5, 5, -1, 'label')).toThrow(/non-negative integer/);
    });

    test('throws when decimals is not an integer', () => {
        expect(() => assertTruncatedTo(5, 5, 1.5, 'label')).toThrow(/non-negative integer/);
    });
});
