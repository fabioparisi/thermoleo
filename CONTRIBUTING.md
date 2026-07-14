# Contributing

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in your own vendor credentials and secrets
npm run dev
```

You'll need a Supabase project with the migrations in `supabase/migrations/` applied in order, and credentials for whichever vendor integrations you're touching.

## Testing

```bash
npm run lint            # ESLint
npx tsc --noEmit        # Type check
npm run test:e2e        # Vitest end-to-end cycle invariants
npx vitest run tests/unit
```

There is no single `npm test` — run unit and e2e separately as above.

## Pull request expectations

- **Small diffs.** Prefer several focused PRs over one large one.
- **Tests for behavior changes.** If a change affects what the agent decides or does, add or update a test under `tests/unit/` or `tests/e2e/` that would fail without the change.
- **Safety-path code is byte-identical unless proven otherwise.** `src/lib/agent/safety.ts` and any code on the safety-check path are treated as safety-critical: log strings and Supabase payloads written from these paths must not drift across a refactor without a test that pins the new behavior. If you touch this code and can't point to a test covering the change, expect it to be asked for in review.
- Match existing code style; don't reformat files you're not otherwise changing.
