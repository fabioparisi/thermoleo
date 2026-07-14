# ThermoLeo — Documentation Index

This `docs/` directory is the long-form documentation for the ThermoLeo home-heating agent. The top-level [README.md](../README.md) remains the short architecture overview; this directory is for the deep dives, the deployment story, and the cross-Mac unification plan.

## Read in this order

1. [Project Overview](project-overview.md) — what ThermoLeo is, why it exists, what it controls
2. [System Architecture](system-architecture.md) — module map and diagrams
3. [Agent Loop](agent-loop.md) — `/api/agent/cycle` step-by-step + per-room state machine
4. [Sensor Pipeline](sensor-pipeline.md) — Sonoff → Homey → Supabase, both paths
5. [Local Agent](local-agent.md) — `agent/monitor.js` and launchd
6. [Bridge App](bridge-app.md) — the Homey-side Sonoff app in `thermoleo-bridge/`
7. [API Reference](api-reference.md) — every route, one-line summary + auth
8. [Deployment Topology](deployment-topology.md) — what runs where, secrets, three-path failure model
9. [Testing Guide](testing-guide.md) — E2E invariants and why no unit tests
10. [Unification Plan](unification-plan.md) — reconcile the two Macs (canonical = this volume)

## Provenance

These docs were generated on 2026-05-25 from the canonical pre-today state of the repo (HEAD `3fdb32c`, Apr 27). Today's portable-launchd attempt on the sibling Mac (`/Users/fabio`) was intentionally excluded per the user's instruction — see [unification-plan.md](unification-plan.md) for the recovery path if any of that work is wanted later.
