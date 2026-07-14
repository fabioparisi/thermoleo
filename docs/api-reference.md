# API Reference

All routes live under `src/app/api/`. Vercel Cron is the primary caller; the dashboard UI is the secondary caller.

## Auth model

| Surface | Auth |
|---|---|
| Cron route (`/api/agent/cycle`) | Bearer token = `AGENT_CRON_SECRET` env. Fail-closed: 401 when missing. Called by Supabase `pg_cron` jobid=1 every 10 min. |
| Sensor ingest (`/api/sensors/ingest`) | Header `x-ingest-secret`, value must match `SENSORS_INGEST_SECRET` env. |
| Health (`/api/health/bridge`) | Public read of derived health, no auth. |
| Room CRUD, settings | Open within the app (single-tenant). |
| Bticino / Netatmo / Homey OAuth callbacks | Public by definition; state token validated. |

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/agent/cycle` | GET | The agent cycle — sensors → decisions → actuation → state persistence. The boiler-call invariant lives inside `manageThermostat()` called from here. |
| `/api/health/bridge` | GET | Diagnostic over `sonoff_bridge` freshness. CRITICAL when leone is stale, WARNING when ≥ 3 rooms are stale. Called by the UI; the agent cycle has its own bridge-silent alarm. |
| `/api/health/homey` | GET | Homey reachability check (placeholder / TODO in canonical state). |
| `/api/sensors/ingest` | POST | Webhook accepting Sonoff readings from the Homey Bridge app. Validates `x-ingest-secret`, upserts to `sonoff_bridge`. |
| `/api/sabiana/status` | GET | Read-only Sabiana fancoil state. Now called from `/api/agent/cycle` directly; standalone route kept for the dashboard. |
| `/api/sabiana/command` | POST | Direct Sabiana command surface for the dashboard / debugging. |
| `/api/netatmo/status` | GET | Read-only Netatmo / Smarther 2 state. |
| `/api/netatmo/setpoint` | POST | Direct setpoint surface for the dashboard / debugging. |
| `/api/netatmo/auth` | GET | Start Netatmo OAuth. |
| `/api/netatmo/callback` | GET | OAuth callback — exchanges code for tokens, stores in Supabase `tokens`. |
| `/api/auth/homey/start` | GET | Start Homey OAuth. |
| `/api/auth/homey/callback` | GET | OAuth callback for Homey Pro. |
| `/api/legrand/callback` | POST | OAuth callback stub reserving the redirect URI for the in-progress Works-With-Legrand migration. |
| `/api/rooms` | GET / POST | Room list and creation. |
| `/api/rooms/[id]` | GET / PATCH | Per-room target temp CRUD. |
| `/api/settings` | GET / POST | Season override + global toggles. |

## Response shape — `/api/agent/cycle`

```json
{
  "cycle": 12345,
  "timestamp": "2026-04-26T08:00:00.000Z",
  "elapsed_ms": 8421,
  "heating": ["leone", "camera"],
  "satisfied": ["studio", "soggiorno", "cucina"],
  "disabled": ["bagno1", "bagno2"],
  "thermostat": "Smarther 2: target 22.0°C, measured 21.4°C, boosted to 23.5°C (warmest heating + 2.5°C)",
  "log": "Cycle #12345 ...\n  leone: 19.8 → target 21.0 (heating, fan 2)\n  ..."
}
```

The Vitest E2E suite asserts the log starts with `Cycle #N`, the elapsed time is < 55 s, and the heating set is a subset of known room ids. See [Testing Guide](testing-guide.md).

## Known deprecations

- `/api/sabiana/*` and `/api/netatmo/*` standalone routes are kept for the dashboard but are no longer called from the cron path — the cycle route invokes the client libraries directly.
- The Energy-API Netatmo helper (`setRoomThermpoint`) was removed during the refactor — Smarther 2 returns *"The device is not a ThermRelay"* on that endpoint. All Netatmo writes go through `setRoomState` (BNS API).

## See also

- [Agent Loop](agent-loop.md)
- [Testing Guide](testing-guide.md)
- Skill reference: `~/.claude/skills/thermoleo/` (mirror in `docs/skill-thermoleo/`)
