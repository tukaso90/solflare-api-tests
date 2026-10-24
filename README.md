# Solflare Wallet API — Test Suite

API test suite for two Solflare `wallet-api` portfolio endpoints, built with
[Playwright Test](https://playwright.dev/docs/test-api-testing)'s API
testing support (`APIRequestContext` — no browsers involved) and
TypeScript, with response shapes validated by [zod](https://zod.dev)
before any math runs on them.

## Prerequisites

- Node.js 22 or later (tested on v24)
- Nothing else — this suite makes no browsers necessary at all (API-only).

## Install

```bash
npm install
```

## Run

```bash
npm test          # run the full suite
npm run test:report  # open the last run's HTML report
npm run typecheck    # tsc --noEmit
```

A fresh `uuid4` is generated once per run (simulating one app install) and
logged to the console at the start of the run, e.g.:

```
[solflare-api-tests] app install id for this run: fe614673-c0ed-4ebc-9072-f42b2bab0de7
```

### Reports

Three reporters run on every invocation:
- **list** — console output as tests run
- **html** — written to `playwright-report/`, not opened automatically; run
  `npm run test:report` to view it (includes every `test.step`, the raw
  JSON response and computed breakdown attached to each test, and full
  failure details)
- **junit** — written to `test-results/junit.xml`, for CI consumption

## Project structure

```
src/
  api/
    schemas.ts             # zod schemas + inferred types for both endpoints
    wallet-api-client.ts    # thin, typed client wrapping the two endpoints
  test-data/
    addresses.ts            # the two assignment-specified wallet addresses
  utils/
    money.ts                 # tolerance-based money comparison helper
tests/
  portfolio-value.spec.ts   # Scenario 1 and 2 (the required scenarios)
  negative-cases.spec.ts    # negative/edge-case inputs — see below
playwright.config.ts         # reporters, retries, baseURL, auth header
tsconfig.json
```

## Field mapping

Discovered by calling both endpoints live and inspecting the actual
response shapes (the API has no published docs beyond the two routes and
request bodies given in the assignment) — see `src/api/schemas.ts` for the
validated shape.

| Assignment term | Field |
|---|---|
| Scenario 1 "total value" | `GET` response `.value.total` |
| Scenario 1 "sum of price × amount" | `Σ tokens[].totalUiAmount × (tokens[].price?.usdPrice ?? 0)` over all tokens |
| Scenario 1 "stocks value" / "tokens value" | `.stocksValue.total` / `.tokensValue.total` (split by each token's `isStock` flag) |
| Scenario 2 "net worth" | `POST` response `.netWorth` |
| Scenario 2 "sum of the two Scenario 1 totals" | `GET(addr1).value.total + GET(addr2).value.total` |
| Scenario 2 "sum of per-wallet values" | `Σ POST.data[].value` |

Notes on the underlying data:
- `totalUiAmount` is already decimal-scaled (e.g. `0.01001`, not the raw
  `"10010000"` integer) — used directly, never rescaled by `decimals`.
- A token with no known price omits the `price` field entirely (it is not
  present as `price: null`) — treated as contributing `0` to any value sum.
  The schema accepts both forms defensively, since only "absent" has been
  observed live.
- `POST /v2/portfolio/balances` is called once per Scenario-2 test with
  **both** addresses in a single `pubkeys` array (not two separate POSTs) —
  matching how the endpoint is designed to batch wallets, and making "net
  worth" naturally mean the combined net worth across both.
- The API strips the leading `"1"` prefix from `pubkeys` entries in its
  response: `data[].publicKey` comes back as the bare address.

## Tolerance rationale

All money comparisons go through `assertMoneyClose()` in
`src/utils/money.ts`, never exact float equality. Two tolerances:

- **`TIGHT_TOLERANCE`** (absolute `1e-9`, relative `0`) — for comparisons
  where both numbers come from the **same** API response (e.g. summing
  token values against that response's own reported total). Any gap here
  should only ever be floating-point rounding noise.
- **`CROSS_ENDPOINT_TOLERANCE`** (absolute `0.01`, relative `0.0005`) — for
  comparisons across **separate** HTTP calls (a GET and a POST made a few
  seconds apart) against live, moving token prices. A small real price tick
  between calls is expected behavior, not a bug; Scenario 2 calls its GETs
  and POST back-to-back specifically to keep this gap as small as possible
  in practice, but doesn't rely on it being exactly zero.

A third, situational tolerance is used only for the optional raw-amount
cross-check (see Findings #3 below): a **per-token** tolerance of exactly
`10^-decimals` (one base unit), because the API truncates displayed amounts
to each token's own decimal precision — a fixed tolerance would be far too
loose for small-decimals tokens and unnecessarily tight for others.

## Negative and edge cases

`tests/negative-cases.spec.ts` covers five inputs, chosen because each
produced a stable, deterministic response during manual discovery (curl +
Playwright, repeated several times) before any assertion was written. These
assert **current observed behavior**, not a published spec — none exists
for this API — so an intentional future API change could legitimately
require updating them.

| Input | Status | Notes |
|---|---|---|
| Missing `Authorization` header | 401/403 | Rejected at the **Cloudflare edge**, before Solflare's application ever sees the request (see Findings #4) |
| Malformed (non-uuid) bearer value | 403 | Rejected by the **application** — plain-text `Invalid API key!` |
| Invalid address | 400 | JSON `HttpValidationError` |
| Unsupported `network` value | 400 | JSON `HttpValidationError` |
| Empty `pubkeys` array (balances) | 200 | Treated as a valid, trivially-empty portfolio — **not** an error |

A minor consistency observation: auth-related errors come back as plain
text (`Invalid API key!`), while input-validation errors come back as a
structured JSON `HttpValidationError` shape — two different error formats
for two different failure categories.

## Flaky-by-nature behavior

Scenario 2's cross-endpoint comparisons depend on live, moving token
prices. `CROSS_ENDPOINT_TOLERANCE` is sized to absorb normal price drift
between a GET and the POST made immediately after it, but on a day with
unusually sharp price movement within that window, a genuine (not
code-related) failure is possible. Retries are `0` locally, `1` in CI
(`playwright.config.ts`) specifically to absorb this class of flake without
hiding a real regression — a failure that doesn't pass on retry is worth
looking at, not just re-running again.

## Findings

Discrepancies found against the live API while building this suite. Each
was investigated to its root cause and fixed properly — corrected
assertions/schemas to match real, verified API behavior — rather than
loosened or excluded to make a failure go away.

### 1. `price` is absent, not `null`, for tokens with no known price

Some tokens in a `GET /v3/portfolio/tokens/{address}` response have no
`price` field at all, rather than `price: null`. Observed live on address
`96Y3j66AX16noUAAVriW8bmwTGzV1PVqBKCEArPd5fuU`, tokens `ICSG` and `JUJI`.
The schema (`src/api/schemas.ts`) allows both `null` and "absent"
defensively, since only the latter has actually been observed.

### 2. xStock (Token-2022) tokens apply a `scalingFactor` on top of raw decimals

Token `SPYX` (`SP500 xStock`, held by address
`7eXxD3vQww9cgBgD3gb7iqTriAzAmCBXFBMpdDi71P3i`) is an SPL Token-2022 token
using the "Scaled UI Amount" extension. Its `totalUiAmount` is **not**
simply `raw amount / 10^decimals`:

```
raw amount:     308335
decimals:       8
scalingFactor:  1.005714560286254

308335 / 10^8                    = 0.00308335
0.00308335 × 1.005714560286254   = 0.00310096   ✓ matches the API's totalUiAmount
```

Without the `scalingFactor` multiplier, the computed amount is off by
~0.57% — not floating-point noise. The field is present (and the
multiplication applies) specifically on tokens with
`standard: "spl-token-2022"`; the test asserts that pairing holds.

### 3. `totalUiAmount` is truncated, not rounded, to the token's decimals

Continuing the SPYX example: the full-precision computation above is
`0.0031009699894586212`, but the API reports `totalUiAmount: 0.00310096`.
Truncating (not rounding) the computed value to 8 decimal places gives
exactly `0.00310096`; rounding would give `0.00310097`. So the API's
reported amount can be up to (but never a full unit of) one base unit —
i.e. `10^-decimals` — below the full-precision computed value. The
raw-amount check in `tests/portfolio-value.spec.ts` uses a per-token
tolerance of `10^-decimals` to account for this, rather than a fixed
tolerance (which would be far too loose for small-decimals tokens and
unnecessarily tight for others).

### 4. A missing `Authorization` header is rejected at the Cloudflare edge, not by the app

A request to `GET /v3/portfolio/tokens/{address}` with no `Authorization`
header at all returns `403` with an HTML Cloudflare challenge page —
confirmed identically via curl (default User-Agent and Playwright's exact
User-Agent) and via an isolated Playwright `APIRequestContext`, three times
each, every time. This is Cloudflare's own edge/WAF rejecting the request
before Solflare's application ever sees it, distinct from the malformed-
bearer case (`Invalid API key!`), which **is** an app-level response.

Getting a clean, isolated "no Authorization header" request out of
Playwright Test took one extra step worth noting: **Playwright Test applies
the project's `use` config — including `extraHTTPHeaders` — as defaults to
every `APIRequestContext` created during a test run**, not just the
`request` fixture. A context built via the standalone `request.newContext()`
factory with no `extraHTTPHeaders` specified still silently carried this
suite's configured `Authorization` header (confirmed directly), so the test
had to pass `extraHTTPHeaders: {}` explicitly to actually produce a
header-less request. The test also includes a positive control — the same
kind of isolated context, but with a valid bearer — to directly prove the
403 is caused by the missing header and nothing else about using an
isolated context.
