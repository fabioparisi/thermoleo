-- 007_campomarino_activate.sql — turn Campomarino ON (summer cool).
--
-- Phase 8.7-lite: the owner chose to actuate the 3 splits NOW on each split's
-- internal thermometer (Shelly H&T arrive later and will become the
-- authoritative reading). Three changes, all to campomarino rows only — Milano
-- is untouched:
--
--   1. safety_max 27.5 → 27.9. 27.5°C is still comfort; 27.9°C trips the
--      too-hot critical alert (owner spec 2026-06-21). safety_min stays 23.
--   2. actuation_enabled false → true on all 3 rooms — the agent now commands
--      the splits (gated by the per-room hysteresis + rate-limits).
--   3. settings:campomarino season off → cool (summer; the family is there).
--
-- The split runs 'dry' (dehumidify, gentle) by default until the Shelly feed
-- humidity; >50% → dry, ≤50% → cool. Milano stays season=off + byte-identical.
--
-- Idempotent: re-running sets the same values.

UPDATE rooms
SET safety_max = 27.9, actuation_enabled = true
WHERE property_id = 'campomarino';

UPDATE tokens
SET data = jsonb_set(data, '{season}', '"cool"'::jsonb),
    updated_at = now()
WHERE provider = 'settings:campomarino';
