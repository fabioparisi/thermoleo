-- 005_drop_nude_tokens.sql — Phase 6 of multi-property-campomarino.
--
-- Drops the three now-ORPHANED nude per-property `tokens` rows. Phase 5
-- namespaced agent_state / setpoint_overrides / settings to `:milano` suffixed
-- rows; the deployed code reads suffixed-first and writes ONLY suffixed, so the
-- nude rows have been drained (no writer touches them) since the Phase 5 deploy.
--
-- Safety (dual-board verified, Opus + GLM unanimous SAFE TO DROP):
--   * Exact-match IN list — CANNOT hit a suffixed row (`agent_state:milano` ≠
--     `agent_state`; Postgres `=` on a literal colon, no LIKE/wildcard).
--   * Vendor tokens (netatmo_home, netatmo_room_map, homey_*, sabiana_*,
--     legrand, …) are NOT in the list — untouched, stay nude forever.
--   * No code path reads a bare provider outside the 4 namespaced loaders
--     (loadAgentState / loadOverrides / readSettings+writeSettings / loadSeason)
--     — verified by grep. No FK references tokens(provider), no trigger, no
--     pg_cron job reads tokens (jobid=1 POSTs to /cycle; jobid=4 cleans
--     readings).
--   * All three `:milano` rows confirmed to exist and settings:milano.season=off
--     before running, so the readers' nude-fallback branch is never exercised
--     post-drop.
--   * Pre-drop snapshot of the 3 rows saved to
--     supabase/005_dropped_nude_tokens.backup.json (audit trail; the suffixed
--     rows are the live/fresher copies, so recovery value is ~0).
--
-- Idempotent: re-running is a harmless no-op once the rows are gone.

DELETE FROM tokens
WHERE provider IN ('agent_state', 'setpoint_overrides', 'settings');
