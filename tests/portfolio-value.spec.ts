import { test, expect, type TestInfo } from '@playwright/test';
import { WalletApiClient } from '../src/api/wallet-api-client.ts';
import { TEST_ADDRESSES } from '../src/test-data/addresses.ts';
import { assertMoneyClose, assertTruncatedTo, TIGHT_TOLERANCE, CROSS_ENDPOINT_TOLERANCE } from '../src/utils/money.ts';

const NETWORK = 'mainnet';

// Evidence for CROSS_ENDPOINT_TOLERANCE (see README "Tolerance rationale"):
// attaches the actual gap, as a percentage, alongside the tolerance that
// was allowed and how much time elapsed between the relevant GET(s) and
// the POST, for every cross-endpoint money comparison in Scenario 2.
async function attachCrossEndpointComparison(
    testInfo: TestInfo,
    name: string,
    params: { label: string; actual: number; expected: number; elapsedMs: number }
): Promise<void> {
    const { label, actual, expected, elapsedMs } = params;
    const absoluteDifference = Math.abs(actual - expected);
    const allowedTolerance = CROSS_ENDPOINT_TOLERANCE.absolute + CROSS_ENDPOINT_TOLERANCE.relative * Math.abs(expected);

    await testInfo.attach(`cross-endpoint-comparison-${name}.json`, {
        body: JSON.stringify(
            {
                label,
                actual,
                expected,
                absoluteDifference,
                percentageDifference: expected !== 0 ? (absoluteDifference / Math.abs(expected)) * 100 : null,
                allowedTolerance,
                elapsedMs
            },
            null,
            2
        ),
        contentType: 'application/json'
    });
}

test.describe('Portfolio value', () => {
    test('Scenario 1: total value matches token math, for both addresses', async ({ request }, testInfo) => {
        const client = new WalletApiClient(request);

        for (const address of TEST_ADDRESSES) {
            await test.step(`address ${address}`, async () => {
                const tokensResponse = await test.step('fetch tokens', async () => {
                    const { raw, parsed } = await client.getTokens(address, NETWORK);
                    await testInfo.attach(`tokens-${address}.raw.json`, {
                        body: JSON.stringify(raw, null, 2),
                        contentType: 'application/json'
                    });
                    return parsed;
                });

                await test.step('guard: wallet actually has data', async () => {
                    // If this ever fails, the live wallet's contents changed —
                    // it emptied out or its value dropped to zero — not that
                    // the API broke. Re-run discovery and pick new test data.
                    expect(
                        tokensResponse.tokens.length,
                        `wallet ${address} has no tokens — test data may have changed, re-run discovery`
                    ).toBeGreaterThan(0);
                    expect(
                        tokensResponse.value.total,
                        `wallet ${address} total value is 0 — test data may have changed, re-run discovery`
                    ).toBeGreaterThan(0);
                });

                await test.step('value.total matches sum(price * amount)', async () => {
                    const excludedForNullPrice: string[] = [];
                    const excludedForNullPriceWithValue: string[] = [];
                    let allSum = 0;
                    let tokensSum = 0;
                    let stocksSum = 0;

                    const breakdown = tokensResponse.tokens.map((token) => {
                        const usdPrice = token.price?.usdPrice;
                        const contribution = usdPrice != null ? token.totalUiAmount * usdPrice : 0;

                        if (usdPrice == null) {
                            excludedForNullPrice.push(token.symbol);
                            if (token.totalUiAmount > 0) excludedForNullPriceWithValue.push(token.symbol);
                        }
                        allSum += contribution;
                        if (token.isStock) stocksSum += contribution;
                        else tokensSum += contribution;

                        return {
                            symbol: token.symbol,
                            isStock: token.isStock,
                            totalUiAmount: token.totalUiAmount,
                            usdPrice: usdPrice ?? null,
                            contribution
                        };
                    });

                    await testInfo.attach(`breakdown-${address}.json`, {
                        body: JSON.stringify({ breakdown, excludedForNullPrice }, null, 2),
                        contentType: 'application/json'
                    });

                    if (excludedForNullPrice.length > 0) {
                        console.log(
                            `[${address}] excluded from value math (price: null): ${excludedForNullPrice.join(', ')}`
                        );
                    }

                    // Not an assertion — these tokens have a real, non-zero
                    // balance but no price, so they're silently excluded
                    // from every value sum above. Surfaced as a warning
                    // annotation so it's visible in the HTML report rather
                    // than only in the attached breakdown JSON.
                    if (excludedForNullPriceWithValue.length > 0) {
                        testInfo.annotations.push({
                            type: 'warning',
                            description:
                                `${address}: tokens with a positive balance but no price (excluded from value math): ` +
                                excludedForNullPriceWithValue.join(', ')
                        });
                    }

                    assertMoneyClose(
                        allSum,
                        tokensResponse.value.total,
                        TIGHT_TOLERANCE,
                        `${address}: sum(price * amount) over ALL tokens vs value.total`
                    );
                    assertMoneyClose(
                        tokensSum,
                        tokensResponse.tokensValue.total,
                        TIGHT_TOLERANCE,
                        `${address}: sum(price * amount) over non-stock tokens vs tokensValue.total`
                    );
                    assertMoneyClose(
                        stocksSum,
                        tokensResponse.stocksValue.total,
                        TIGHT_TOLERANCE,
                        `${address}: sum(price * amount) over stock tokens vs stocksValue.total`
                    );
                });

                await test.step('value.total equals tokensValue.total + stocksValue.total', async () => {
                    assertMoneyClose(
                        tokensResponse.value.total,
                        tokensResponse.tokensValue.total + tokensResponse.stocksValue.total,
                        TIGHT_TOLERANCE,
                        `${address}: value.total vs tokensValue.total + stocksValue.total`
                    );
                });

                await test.step('optional: totalUiAmount matches raw amount / 10^decimals', async () => {
                    for (const token of tokensResponse.tokens) {
                        // Tokens using the SPL Token-2022 "Scaled UI Amount"
                        // extension (e.g. xStock tokenized-equity tokens)
                        // apply an extra multiplier on top of the plain
                        // decimal scaling — discovered live on SPYX, where
                        // totalUiAmount only matched once scalingFactor was
                        // included. See README "Findings" for the numbers.
                        if (token.scalingFactor != null) {
                            expect(
                                token.standard,
                                `${address}/${token.symbol}: tokens with scalingFactor are expected to be spl-token-2022`
                            ).toBe('spl-token-2022');
                        }

                        // Summed as BigInt, not Number: raw on-chain amounts
                        // are provided as strings specifically because they
                        // can exceed Number's safe integer range, and that
                        // precision would already be lost before summing if
                        // each were converted to Number first. The BigInt
                        // sum itself is exact; Number(rawTotal) below is
                        // still a lossy conversion once that sum exceeds
                        // Number.MAX_SAFE_INTEGER, so this check is only
                        // approximate for a token whose raw total gets that
                        // large (flagged below, not assumed away).
                        const rawTotal = token.accounts.reduce((sum, account) => sum + BigInt(account.amount), 0n);

                        if (rawTotal > BigInt(Number.MAX_SAFE_INTEGER)) {
                            testInfo.annotations.push({
                                type: 'warning',
                                description:
                                    `${address}/${token.symbol}: raw amount (${rawTotal}) exceeds ` +
                                    `Number.MAX_SAFE_INTEGER — the totalUiAmount cross-check for this token is ` +
                                    `only approximate due to Number precision loss`
                            });
                        }

                        const expectedUiAmount = (Number(rawTotal) / 10 ** token.decimals) * (token.scalingFactor ?? 1);

                        // The API truncates (not rounds) totalUiAmount to the
                        // token's decimals — discovered live on SPYX, where
                        // our full-precision computation (0.0031009699894586212)
                        // truncates to exactly the API's 0.00310096, while
                        // rounding would give ...97. assertTruncatedTo proves
                        // the rounding-DOWN rule directly: it fails if the
                        // API's value is above the full-precision computation
                        // (rounded up) or a full base unit (10^-decimals)
                        // below it, rather than allowing a symmetric gap in
                        // either direction.
                        assertTruncatedTo(
                            token.totalUiAmount,
                            expectedUiAmount,
                            token.decimals,
                            `${address}/${token.symbol}: totalUiAmount vs (sum(accounts[].amount) / 10^decimals) * (scalingFactor ?? 1)`
                        );
                    }
                });
            });
        }
    });

    test('Scenario 2: net worth matches balances sum and Scenario 1 totals', async ({ request }, testInfo) => {
        const client = new WalletApiClient(request);

        // GET and POST are called back-to-back, right next to each other, so
        // the live prices behind both are as close in time as practical —
        // see CROSS_ENDPOINT_TOLERANCE for why a small gap is still expected.
        const tokensByAddress = await test.step('fetch tokens for both addresses', async () => {
            const results = [];
            for (const address of TEST_ADDRESSES) {
                const { raw, parsed } = await client.getTokens(address, NETWORK);
                const fetchedAt = Date.now();
                await testInfo.attach(`tokens-${address}.raw.json`, {
                    body: JSON.stringify(raw, null, 2),
                    contentType: 'application/json'
                });
                results.push({ address, tokens: parsed, fetchedAt });
            }
            return results;
        });

        let balancesFetchedAt = 0;
        const balances = await test.step('POST balances for both addresses', async () => {
            const pubkeys = TEST_ADDRESSES.map((address) => `1${address}`);
            const { raw, parsed } = await client.getBalances(pubkeys, 'usd', NETWORK);
            balancesFetchedAt = Date.now();
            await testInfo.attach('balances.raw.json', {
                body: JSON.stringify(raw, null, 2),
                contentType: 'application/json'
            });
            return parsed;
        });

        await test.step('data contains exactly the two requested addresses', async () => {
            // The API strips the leading "1" we prefix pubkeys with when
            // building the request — confirmed against the live response.
            const returnedAddresses = balances.data.map((entry) => entry.publicKey).toSorted();
            expect(returnedAddresses).toEqual([...TEST_ADDRESSES].toSorted());
        });

        await test.step('each wallet value matches its scenario 1 total', async () => {
            for (const { address, tokens, fetchedAt } of tokensByAddress) {
                const entry = balances.data.find((candidate) => candidate.publicKey === address);
                expect(entry, `balances response has no entry for ${address}`).toBeDefined();

                const label = `${address}: balances data[].value vs GET value.total`;
                await attachCrossEndpointComparison(testInfo, address, {
                    label,
                    actual: entry!.value,
                    expected: tokens.value.total,
                    elapsedMs: balancesFetchedAt - fetchedAt
                });

                assertMoneyClose(entry!.value, tokens.value.total, CROSS_ENDPOINT_TOLERANCE, label);
            }
        });

        await test.step('net worth equals sum of scenario 1 totals', async () => {
            const sumOfGetTotals = tokensByAddress.reduce((sum, entry) => sum + entry.tokens.value.total, 0);
            const label = 'netWorth vs sum of GET value.total for both addresses';
            const maxElapsedMs = Math.max(...tokensByAddress.map((entry) => balancesFetchedAt - entry.fetchedAt));

            await attachCrossEndpointComparison(testInfo, 'networth', {
                label,
                actual: balances.netWorth,
                expected: sumOfGetTotals,
                elapsedMs: maxElapsedMs
            });

            assertMoneyClose(balances.netWorth, sumOfGetTotals, CROSS_ENDPOINT_TOLERANCE, label);
        });

        await test.step('net worth equals sum of balances data values', async () => {
            const sumOfDataValues = balances.data.reduce((sum, entry) => sum + entry.value, 0);
            assertMoneyClose(
                balances.netWorth,
                sumOfDataValues,
                TIGHT_TOLERANCE,
                'netWorth vs sum of balances data[].value'
            );
        });
    });
});
