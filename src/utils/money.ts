/**
 * Tolerance for a money comparison: passes when
 * |actual - expected| <= absolute + relative * |expected|.
 */
export interface Tolerance {
    absolute: number;
    relative: number;
}

/**
 * For comparisons where both numbers come from the SAME API response (e.g.
 * summing token values against that response's own reported total). Any gap
 * here should only ever be floating-point rounding noise, not business
 * logic drift, so this is deliberately tight.
 */
export const TIGHT_TOLERANCE: Tolerance = { absolute: 1e-9, relative: 0 };

/**
 * For comparisons across two separate HTTP calls (e.g. a GET and a POST
 * made a few seconds apart) against live, moving token prices. A real price
 * tick between calls is expected behavior, not a bug, so this allows a
 * small absolute gap (covers sub-cent rounding on small portfolios) plus a
 * small relative gap (covers price drift scaling with portfolio size).
 */
export const CROSS_ENDPOINT_TOLERANCE: Tolerance = { absolute: 0.01, relative: 0.0005 };

/**
 * Asserts `actual` is within `tolerance` of `expected`, throwing a
 * descriptive error (expected, actual, difference, and the tolerance that
 * was applied) if not. Deliberately not `expect().toBeCloseTo()`: that
 * matcher only supports a fixed decimal-digit precision, not the
 * absolute-plus-relative tolerance this suite needs for both tiny token
 * amounts and large portfolio totals.
 */
export function assertMoneyClose(actual: number, expected: number, tolerance: Tolerance, label: string): void {
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
        throw new Error(
            `${label}\n` +
                `  expected and actual must both be finite numbers (any comparison involving NaN is ` +
                `always false, which would make this helper silently pass)\n` +
                `  expected: ${expected}\n` +
                `  actual:   ${actual}`
        );
    }
    if (!Number.isFinite(tolerance.absolute) || !Number.isFinite(tolerance.relative)) {
        throw new Error(
            `${label}\n` +
                `  tolerance.absolute and tolerance.relative must both be finite numbers\n` +
                `  absolute: ${tolerance.absolute}\n` +
                `  relative: ${tolerance.relative}`
        );
    }
    if (tolerance.absolute < 0 || tolerance.relative < 0) {
        throw new Error(
            `${label}\n` +
                `  tolerance.absolute and tolerance.relative must both be non-negative\n` +
                `  absolute: ${tolerance.absolute}\n` +
                `  relative: ${tolerance.relative}`
        );
    }

    const difference = Math.abs(actual - expected);
    const allowed = tolerance.absolute + tolerance.relative * Math.abs(expected);

    if (difference > allowed) {
        throw new Error(
            `${label}\n` +
                `  expected:   ${expected}\n` +
                `  actual:     ${actual}\n` +
                `  difference: ${difference}\n` +
                `  tolerance:  ${allowed} (absolute ${tolerance.absolute} + relative ${tolerance.relative} * |expected|)`
        );
    }
}

/**
 * Asserts `actual` is `expected` truncated (rounded toward zero, never up)
 * to `decimals` decimal places — the API's own truncation rule for
 * `totalUiAmount` (see README Finding #2) — rather than a symmetric
 * tolerance. Passes when `0 <= expected - actual < 10^-decimals`, i.e.
 * `actual` is never above `expected` (upward rounding is a real bug) and
 * never a full base unit below it. A tiny relative epsilon
 * (`1e-12 * |expected|`) is subtracted from the lower bound to absorb
 * floating-point noise on tokens where the two values are effectively
 * equal.
 */
export function assertTruncatedTo(actual: number, expected: number, decimals: number, label: string): void {
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
        throw new Error(
            `${label}\n` +
                `  expected and actual must both be finite numbers\n` +
                `  expected: ${expected}\n` +
                `  actual:   ${actual}`
        );
    }
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error(`${label}\n` + `  decimals must be a non-negative integer, got: ${decimals}`);
    }

    const difference = expected - actual;
    const unit = 10 ** -decimals;
    const epsilon = 1e-12 * Math.abs(expected);

    if (difference < -epsilon || difference >= unit) {
        throw new Error(
            `${label}\n` +
                `  expected (full precision): ${expected}\n` +
                `  actual (API-reported):     ${actual}\n` +
                `  difference (expected - actual): ${difference}\n` +
                `  allowed range: [${-epsilon}, ${unit}) — actual must truncate expected toward zero ` +
                `to ${decimals} decimals, never round up or drop a full unit`
        );
    }
}
