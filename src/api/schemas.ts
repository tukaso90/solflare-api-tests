import { z } from 'zod';

// Shared shape of value/tokensValue/stocksValue in the tokens response —
// only the fields this suite actually reads. Extra API fields (e.g.
// solValue, onrampTokenId) are left unvalidated; zod ignores unknown keys
// on a plain object schema, so new fields can't break this suite.
const MoneySummarySchema = z.object({
    total: z.number()
});

// The whole `price` field — not just usdPrice — can be missing from the
// token entirely when a token has no known price, observed directly on the
// live API (ICSG, JUJI). Allowing both `null` and "absent" defensively,
// since we've only confirmed the latter and the API may do either.
const PriceSchema = z
    .object({
        usdPrice: z.number()
    })
    .nullable()
    .optional();

const TokenAccountSchema = z.object({
    // Raw on-chain integer amount, as a string (Solana token amounts can
    // exceed Number's safe integer range). Only used by the optional
    // totalUiAmount cross-check in the tests.
    amount: z.string()
});

const TokenSchema = z.object({
    symbol: z.string(),
    isStock: z.boolean(),
    decimals: z.number(),
    // Already decimal-scaled (e.g. 0.01001, not the raw "10010000"
    // integer) — confirmed against accounts[].amount / 10^decimals on the
    // live API. Use this directly; don't rescale it.
    totalUiAmount: z.number(),
    price: PriceSchema,
    accounts: z.array(TokenAccountSchema),
    // Present on SPL Token-2022 tokens using the "Scaled UI Amount"
    // extension (observed on xStock tokenized-equity tokens, e.g. SPYX):
    // totalUiAmount = (raw amount / 10^decimals) * scalingFactor, not just
    // the raw division. Absent on plain SPL tokens. See README "Findings".
    scalingFactor: z.number().optional(),
    standard: z.string().optional()
});

export const TokensResponseSchema = z.object({
    value: MoneySummarySchema,
    tokensValue: MoneySummarySchema,
    stocksValue: MoneySummarySchema,
    tokens: z.array(TokenSchema)
});

export type TokensResponse = z.infer<typeof TokensResponseSchema>;

const BalanceEntrySchema = z.object({
    publicKey: z.string(),
    value: z.number()
});

export const BalancesResponseSchema = z.object({
    netWorth: z.number(),
    data: z.array(BalanceEntrySchema)
});

export type BalancesResponse = z.infer<typeof BalancesResponseSchema>;
