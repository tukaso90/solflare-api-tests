# Solflare Wallet API — Test Suite

API test suite for two Solflare `wallet-api` portfolio endpoints, built with
[Playwright Test](https://playwright.dev/docs/test-api-testing)'s API
testing support (`APIRequestContext` — no browsers involved) and
TypeScript, with response shapes validated by [zod](https://zod.dev)
before any math runs on them.

## Prerequisites

- Node.js 22 or later (tested on v24)
- No browsers required (API-only).

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
  JSON response (`*.raw.json`, the actual API body, before zod parsing
  drops any undeclared field) and computed breakdown attached to each
  test, and full failure details)
- **junit** — written to `test-results/junit.xml`, for CI consumption

## Project structure

```
src/
  api/
    schemas.ts             # zod schemas + inferred types for both endpoints
    wallet-api-client.ts   # thin, typed client wrapping the two endpoints
  test-data/
    addresses.ts           # the two assignment-specified wallet addresses
  utils/
    money.ts               # tolerance-based money comparison helper
tests/
  portfolio-value.spec.ts  # Scenario 1 and 2 (the required scenarios)
  negative-cases.spec.ts   # negative/edge-case inputs — see below
  unit/
    money.spec.ts          # unit tests for the money helpers — no network
playwright.config.ts       # reporters, retries, baseURL, auth header
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
- A token with no known price **omits the `price` field entirely** rather
  than sending `price: null` — observed live on address
  `96Y3j66AX16noUAAVriW8bmwTGzV1PVqBKCEArPd5fuU`, tokens `ICSG` and `JUJI`.
  Treated as contributing `0` to any value sum; the schema accepts both
  `null` and "absent" defensively, since only the latter has been observed.
  Any token with a positive balance but no price is additionally surfaced
  as a `warning` annotation (not an assertion) so it's visible directly in
  the HTML report, in addition to the existing `breakdown-*.json`
  attachment.
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
  in practice, but doesn't rely on it being exactly zero. Every Scenario 2
  cross-endpoint comparison attaches a `cross-endpoint-comparison-*.json`
  (absolute difference, percentage difference, the tolerance that was
  allowed, and the elapsed milliseconds between the relevant GET(s) and the
  POST) — this is the evidence behind the tolerance values above, visible
  per-run in the HTML report rather than just asserted blind.

The optional raw-amount cross-check (see Finding #2 below) does **not** use
`assertMoneyClose` — it uses a dedicated `assertTruncatedTo()` (also in
`src/utils/money.ts`) that verifies the API's actual rounding-**down** rule
directly: it passes only when `0 <= (full-precision computed amount -
API's totalUiAmount) < 10^-decimals`, with a tiny relative epsilon
(`1e-12 * |expected|`) on the lower bound to absorb float noise. A
symmetric tolerance would also accept an upward-rounded value, which is a
real bug, not noise.

## Negative and edge cases

`tests/negative-cases.spec.ts` covers five inputs, chosen because each
produced a stable, deterministic response during manual discovery (curl +
Playwright, repeated several times) before any assertion was written. These
assert **current observed behavior**, not a published spec — none exists
for this API — so an intentional future API change could legitimately
require updating them.

| Input | Status | Notes |
|---|---|---|
| Missing `Authorization` header | 401/403 | Rejected at the **Cloudflare edge**, before Solflare's application ever sees the request (see Findings #3) |
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

## Implementation notes

Two non-obvious things about Playwright Test's own behavior, discovered
while building this suite, that shaped how `playwright.config.ts` and
`tests/negative-cases.spec.ts` are written:

- **Config `use` options apply to every `APIRequestContext`, not just the
  `request` fixture.** A context built via the standalone
  `request.newContext()` factory, with no `extraHTTPHeaders` of its own
  specified, still silently inherited this suite's configured
  `Authorization` header (confirmed directly via a temporary header-echo
  diagnostic). Producing a genuinely header-less request — needed for the
  missing-Authorization negative case — required passing
  `extraHTTPHeaders: {}` explicitly to override it, not just omitting the
  option.
- **This config module is imported more than once per run.** Playwright's
  main/orchestrator process imports `playwright.config.ts` to plan the run
  (worker count, reporters, etc.) — it never sends any HTTP request itself
  — and each worker process imports it again to build its own fixtures.
  With more than one worker, each would generate its own `appInstallId`,
  breaking "one uuid4 per run simulates one app install." `workers: 1` is
  pinned for exactly this reason (the suite is small enough that this costs
  nothing), and the UUID log line is additionally gated on
  `TEST_WORKER_INDEX` (set by Playwright only inside worker processes) so
  it prints exactly once — the orchestrator process's import would
  otherwise print a second, unused UUID that's never actually sent in a
  request.

## Findings

Discrepancies found against the live API while building this suite. Each
was investigated to its root cause and fixed properly — corrected
assertions/schemas to match real, verified API behavior — rather than
loosened or excluded to make a failure go away.

### 1. xStock (Token-2022) tokens apply a `scalingFactor` on top of raw decimals

Token `SPYX` (`SP500 xStock`, held by address
`7eXxD3vQww9cgBgD3gb7iqTriAzAmCBXFBMpdDi71P3i`) is an SPL Token-2022 token
using the "Scaled UI Amount" extension. Its `totalUiAmount` is **not**
simply `raw amount / 10^decimals`:

```
raw amount:     308335
decimals:       8
scalingFactor:  1.005714560286254

308335 / 10^8                    = 0.00308335
0.00308335 × 1.005714560286254   ≈ 0.0031009699894586212   (truncated by the API to 0.00310096 — see Finding #2)
```

Without the `scalingFactor` multiplier, the computed amount is off by
~0.57% — not floating-point noise. The field is present (and the
multiplication applies) specifically on tokens with
`standard: "spl-token-2022"`; the test asserts that pairing holds.

### 2. `totalUiAmount` is truncated, not rounded, to the token's decimals

Continuing the SPYX example: the full-precision computation above is
`0.0031009699894586212`, but the API reports `totalUiAmount: 0.00310096`.
Truncating (not rounding) the computed value to 8 decimal places gives
exactly `0.00310096`; rounding would give `0.00310097`. So the API's
reported amount can be up to (but never a full unit of) one base unit —
i.e. `10^-decimals` — below the full-precision computed value, and must
never be above it. The raw-amount check in `tests/portfolio-value.spec.ts`
calls `assertTruncatedTo()` to verify this rounding-**down** rule directly
— it fails on an upward-rounded value (e.g. `0.00310097` for SPYX) just as
readily as on a value more than one base unit too low — rather than a
symmetric tolerance, which would also silently accept the upward-rounded
case. Covered in `tests/unit/money.spec.ts` with the truncated value
(passes), the rounded-up value (fails), and a value one full unit lower
(fails).

**Precision limitation:** the raw per-account amounts are summed as
`BigInt` specifically because a single account's amount can exceed
`Number`'s safe integer range, and that sum is exact. The one unavoidable
`Number(rawTotal)` conversion — needed for the floating-point division by
`10^decimals` — is still lossy if the summed total itself exceeds
`Number.MAX_SAFE_INTEGER`; when that happens for a given token, the test
adds a `warning` annotation noting that token's cross-check is only
approximate, rather than silently assuming full precision. No decimal
library is used for this.

### 3. A missing `Authorization` header is rejected at the Cloudflare edge, not by the app

A request to `GET /v3/portfolio/tokens/{address}` with no `Authorization`
header at all returns `403` with an HTML Cloudflare challenge page —
confirmed identically via curl (default User-Agent and Playwright's exact
User-Agent) and via an isolated Playwright `APIRequestContext`, three times
each, every time. This is Cloudflare's own edge/WAF rejecting the request
before Solflare's application ever sees it, distinct from the malformed-
bearer case (`Invalid API key!`), which **is** an app-level response. The
test includes a positive control — the same kind of isolated context, but
with a valid bearer — to directly prove the 403 is caused by the missing
header and nothing else about using an isolated context. (See
"Implementation notes" above for what it took to get Playwright Test to
actually send a header-less request in the first place.)
