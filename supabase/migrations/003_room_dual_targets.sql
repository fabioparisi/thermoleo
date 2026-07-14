-- Migration 003: Dual targets per room (winter + summer)
--
-- Why: ThermoLeo was designed winter-first. With cooling now in scope, each
-- room needs to remember TWO setpoints — the winter heating target and the
-- summer cooling target — so switching season from the UI restores the
-- correct value without overwriting the other.
--
-- Behaviour:
--   - `target_temp` remains the active target (read by the agent cycle).
--   - `target_winter` and `target_summer` are the persisted-per-season values.
--   - On season flip via /api/settings, the route copies the matching field
--     into `target_temp`. Per-room edits via PATCH /api/rooms/[id] write the
--     value to both `target_temp` AND the season-matching column.
--   - Default summer target: 26°C for every room (user adjusts from UI).
--   - Default winter target: whatever the current `target_temp` is.
--
-- Safe to re-run (IF NOT EXISTS guards).

alter table rooms add column if not exists target_winter numeric;
alter table rooms add column if not exists target_summer numeric;

update rooms set target_winter = target_temp where target_winter is null;
update rooms set target_summer = 26.0 where target_summer is null;

-- Tighten constraints once the backfill has run. NOT NULL is safe because
-- every existing row was populated above.
alter table rooms alter column target_winter set not null;
alter table rooms alter column target_summer set not null;

-- Sanity defaults for any future inserts that forget to set them.
alter table rooms alter column target_winter set default 21.0;
alter table rooms alter column target_summer set default 26.0;
