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
