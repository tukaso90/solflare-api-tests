import type { APIRequestContext } from '@playwright/test';
import {
    BalancesResponseSchema,
    TokensResponseSchema,
    type BalancesResponse,
    type TokensResponse
} from './schemas.ts';

/**
 * Thin wrapper over the two wallet-api portfolio endpoints this suite
 * tests. Parses every response through its zod schema before returning it,
 * so a shape change in the API fails here with a clear validation error
 * instead of surfacing later as a confusing NaN in a money assertion.
 */
export class WalletApiClient {
    constructor(private readonly request: APIRequestContext) {}

    async getTokens(address: string, network: string): Promise<TokensResponse> {
        const response = await this.request.get(`/v3/portfolio/tokens/${address}`, {
            params: { network }
        });

        if (!response.ok()) {
            throw new Error(
                `GET /v3/portfolio/tokens/${address}?network=${network} returned ${response.status()}: ${await response.text()}`
            );
        }

        return TokensResponseSchema.parse(await response.json());
    }

    async getBalances(pubkeys: string[], currency: string, network: string): Promise<BalancesResponse> {
        const response = await this.request.post('/v2/portfolio/balances', {
            data: { pubkeys, currency, general: true, network }
        });

        if (!response.ok()) {
            throw new Error(
                `POST /v2/portfolio/balances returned ${response.status()}: ${await response.text()}`
            );
        }

        return BalancesResponseSchema.parse(await response.json());
    }
}
