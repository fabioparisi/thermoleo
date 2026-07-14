-- 006_campomarino_seed.sql — Phase 7.3 of multi-property-campomarino.
--
-- Seeds the second property (Campomarino) and its 3 Mitsubishi ATA splits.
-- ADDITIVE only: inserts a `properties` row + 3 `rooms` rows. Touches nothing
-- Milano. All campomarino rooms ship `actuation_enabled = false` — the agent
-- reads/logs them but does NOT command until each room's independent sensor
-- (split internal thermometer now, Shelly H&T later) is validated.
--
-- Product facts (confirmed with Fabio 2026-06-21):
--   * CB (Molise), coordinates blurred to town centre.
--   * Real MELCloud DeviceIDs discovered live (building 622008):
--       studio    = 80979947  (Nursery's feeding room → sensitive, critical)
--       camera    = 80980131  (where Nursery sleeps    → sensitive, critical)
--       soggiorno = 80981534  (living room           → normal)
--   * Splits are REVERSIBLE heat pumps → full heat/cool/off per-property like
--     Milano (heat used when the family stays past September). NOT cool-only.
--   * Per-season targets: summer (cool) 26.5°C, winter (heat) 24°C.
--   * Sensitive rooms (studio+camera) safety bounds 23–27.5°C; Nursery-first
--     priority. Soggiorno same comfort range, non-critical.
--
-- Idempotent: ON CONFLICT DO NOTHING on the PKs.

INSERT INTO properties (id, name, timezone, lat, lon)
VALUES ('campomarino', 'Campomarino', 'Europe/Rome', 41.95, 15.05)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rooms (
  id, name, api_source, device_id, icon, priority,
  target_temp_min, target_temp_max, target_temp, target_winter, target_summer,
  property_id, critical, safety_min, safety_max, fan_profile, role,
  actuation_enabled, min_off_minutes
) VALUES
  -- Studio = Nursery's feeding room (sensitive, critical, highest priority)
  ('campomarino_studio', 'Studio (Nursery)', 'melcloud', '80979947', '🍼', 1,
   23.0, 27.5, 26.5, 24.0, 26.5,
   'campomarino', true, 23, 27.5, 'standard', NULL,
   false, 20),
  -- Camera = where Nursery sleeps (sensitive, critical)
  ('campomarino_camera', 'Camera da letto', 'melcloud', '80980131', '🛏️', 2,
   23.0, 27.5, 26.5, 24.0, 26.5,
   'campomarino', true, 23, 27.5, 'standard', NULL,
   false, 20),
  -- Soggiorno = living room (normal)
  ('campomarino_soggiorno', 'Soggiorno', 'melcloud', '80981534', '🛋️', 3,
   23.0, 27.5, 26.5, 24.0, 26.5,
   'campomarino', false, 23, 27.5, 'standard', NULL,
   false, 20)
ON CONFLICT (id) DO NOTHING;

-- Seed the per-property season settings row so campomarino has its own season
-- (independent of Milano). Starts 'off' — the family isn't there yet; flip to
-- 'cool' (summer) or 'heat' (winter) via the UI/settings API when occupied.
INSERT INTO tokens (provider, data, updated_at)
VALUES ('settings:campomarino',
        '{"season":"off","source":"manual","override":null}'::jsonb,
        now())
ON CONFLICT (provider) DO NOTHING;
