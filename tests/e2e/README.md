# ThermoLeo E2E tests

Read-only HTTP tests against the live Vercel production deployment.
Every test issues `GET /api/agent/cycle` and asserts on the response shape.
No mock, no mutation logic — the agent cycle endpoint is the only surface
under test and it is idempotent by design (each invocation is stateless,
state lives in Supabase).

## Prerequisites

- `AGENT_CRON_SECRET` must be in `.env.local` (same secret set on Vercel).
- Prod deployment must be reachable at `https://thermoleo-app.vercel.app`.

## Run

```bash
npm run test:e2e
```

## Safety

Tests never mutate hardware directly. The cycle endpoint DOES emit commands
to Sabiana/Netatmo/Smarther as a side-effect, but the Vercel cron already
runs it every 2 minutes — a handful of extra invocations per test run is
negligible noise on top of the baseline.
