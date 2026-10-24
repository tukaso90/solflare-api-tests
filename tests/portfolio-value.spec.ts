import { test, expect } from '@playwright/test';
import { WalletApiClient } from '../src/api/wallet-api-client.ts';
import { TEST_ADDRESSES } from '../src/test-data/addresses.ts';
import { assertMoneyClose, TIGHT_TOLERANCE, CROSS_ENDPOINT_TOLERANCE } from '../src/utils/money.ts';

const NETWORK = 'mainnet';

test.describe('Portfolio value', () => {
    test('Scenario 1: total value matches token math, for both addresses', async ({ request }, testInfo) => {
        const client = new WalletApiClient(request);

        for (const address of TEST_ADDRESSES) {
            await test.step(`address ${address}`, async () => {
                const tokensResponse = await test.step('fetch tokens', async () => {
                    const response = await client.getTokens(address, NETWORK);
                    await testInfo.attach(`tokens-${address}.json`, {
                        body: JSON.stringify(response, null, 2),
                        contentType: 'application/json'
                    });
                    return response;
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
                    let allSum = 0;
                    let tokensSum = 0;
                    let stocksSum = 0;

                    const breakdown = tokensResponse.tokens.map((token) => {
                        const usdPrice = token.price?.usdPrice;
                        const contribution = usdPrice != null ? token.totalUiAmount * usdPrice : 0;

                        if (usdPrice == null) excludedForNullPrice.push(token.symbol);
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
                        // each were converted to Number first. Number() is
                        // only applied once, to the final sum, right before
                        // the floating-point division below (which needs it).
                        const rawTotal = token.accounts.reduce((sum, account) => sum + BigInt(account.amount), 0n);
                        const expectedUiAmount = (Number(rawTotal) / 10 ** token.decimals) * (token.scalingFactor ?? 1);

                        // The API truncates (not rounds) totalUiAmount to the
                        // token's decimals — discovered live on SPYX, where
                        // our full-precision computation (0.0031009699894586212)
                        // truncates to exactly the API's 0.00310096, while
                        // rounding would give ...97. So the computed value can
                        // exceed the API's by up to (but never a full unit of)
                        // one base unit, i.e. 10^-decimals — a per-token
                        // tolerance, since a fixed one would be far too loose
                        // for small balances and too tight for large ones.
                        assertMoneyClose(
                            token.totalUiAmount,
                            expectedUiAmount,
                            { absolute: 10 ** -token.decimals, relative: 0 },
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
                const response = await client.getTokens(address, NETWORK);
                await testInfo.attach(`tokens-${address}.json`, {
                    body: JSON.stringify(response, null, 2),
                    contentType: 'application/json'
                });
                results.push({ address, tokens: response });
            }
            return results;
        });

        const balances = await test.step('POST balances for both addresses', async () => {
            const pubkeys = TEST_ADDRESSES.map((address) => `1${address}`);
            const response = await client.getBalances(pubkeys, 'usd', NETWORK);
            await testInfo.attach('balances.json', {
                body: JSON.stringify(response, null, 2),
                contentType: 'application/json'
            });
            return response;
        });

        await test.step('data contains exactly the two requested addresses', async () => {
            // The API strips the leading "1" we prefix pubkeys with when
            // building the request — confirmed against the live response.
            const returnedAddresses = balances.data.map((entry) => entry.publicKey).toSorted();
            expect(returnedAddresses).toEqual([...TEST_ADDRESSES].toSorted());
        });

        await test.step('each wallet value matches its scenario 1 total', async () => {
            for (const { address, tokens } of tokensByAddress) {
                const entry = balances.data.find((candidate) => candidate.publicKey === address);
                expect(entry, `balances response has no entry for ${address}`).toBeDefined();

                assertMoneyClose(
                    entry!.value,
                    tokens.value.total,
                    CROSS_ENDPOINT_TOLERANCE,
                    `${address}: balances data[].value vs GET value.total`
                );
            }
        });

        await test.step('net worth equals sum of scenario 1 totals', async () => {
            const sumOfGetTotals = tokensByAddress.reduce((sum, entry) => sum + entry.tokens.value.total, 0);
            assertMoneyClose(
                balances.netWorth,
                sumOfGetTotals,
                CROSS_ENDPOINT_TOLERANCE,
                'netWorth vs sum of GET value.total for both addresses'
            );
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
