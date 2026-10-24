# Solflare Wallet API — Test Suite

(Full README — prerequisites, install, run, project structure, tolerance
rationale — comes in a later phase. This is the "Findings" section only,
written up as each discovery happened during test development.)

## Findings

Two real discrepancies were found against the live API while building the
raw on-chain amount cross-check (`totalUiAmount` vs. the token's raw
`accounts[].amount`). Both are documented here rather than hidden behind a
loosened assertion — the checks were corrected to account for actual API
behavior, not weakened to pass regardless of it.

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
