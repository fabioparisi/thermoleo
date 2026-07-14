# Testing Guide

There is one test suite, by design. It is an E2E invariant check against the live production cycle endpoint — not a unit test pyramid.

## Why E2E only

The agent's job is to drive real hardware on a 2-minute cron schedule. Unit tests on the math would be cheap but would not catch the things that actually break the apartment: a missing Supabase row, a Netatmo OAuth revoke, a Sabiana login change, a Homey reboot. The invariant suite hits the real `/api/agent/cycle` and asserts the things that must always be true regardless of what the underlying code does today.

The cycle is idempotent: state is in Supabase, not in the request, so repeated calls are safe.

## Layout

```
tests/
└── e2e/
    ├── README.md
    └── cycle.test.ts          # 11 invariant assertions
```

Single Vitest config at repo root: `vitest.config.ts`.

## Run

```bash
npm run test:e2e
```

Reads `AGENT_CRON_SECRET` from `.env.local`. Calls the live production URL. Caches one cycle response and shares it across most assertions to minimise hardware side-effects; the few tests that need a fresh call (cycle counter, idempotency) re-fetch.

## Invariants asserted

1. **Auth** — 401 when bearer is missing or wrong.
2. **Cycle counter monotonic** — successive calls return strictly increasing `cycle` numbers.
3. **Heating subset** — `heating[]` is a subset of the known 7 room ids.
4. **Log format** — log starts with `Cycle #N`.
5. **Camera DISABLED** — camera room never appears in `heating[]` unless season is `off` (in which case the assertion is skipped, see `4baf912`).
6. **Thermostat line present** — log always includes a `Smarther 2:` line.
7. **Elapsed bound** — `elapsed_ms` < 55 000 (well under Vercel's 60 s function ceiling).
8. **Sensor count** — bridge reports a count in `0..7`.
9. **Offseason gating** — when season is `off`, no fancoil heating actions are taken; bathroom antifreeze valves are forced.
10. **Response shape** — all expected fields are present with correct types.
11. **Idempotency** — a second call within the same second does not double-actuate (rate-limited).

## What is intentionally NOT tested

- Sabiana / Netatmo / Homey client unit tests — the OAuth + transport layer changes upstream more often than our code does, so we let the real cycle either succeed or fail and observe.
- The bash bridge — covered by `scripts/verify-bridge.sh` (separate health check), not the Vitest suite.
- The dashboard UI — no UI tests today.

## See also

- [Agent Loop](agent-loop.md)
- [API Reference](api-reference.md)
