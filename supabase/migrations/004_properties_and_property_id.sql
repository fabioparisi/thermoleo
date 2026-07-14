-- Migration 004: properties registry + property_id dimension + enriched rooms columns
--
-- WHAT: Makes `property_id` a first-class dimension so a second home
--   ("campomarino") lands as DATA, not a code fork. Adds:
--     - a `properties` registry table (id, name, timezone, lat, lon)
--     - `property_id TEXT NOT NULL DEFAULT 'milano'` on the 5 row-scoped tables
--       (rooms, readings, agent_actions, alerts, sonoff_bridge)
--     - the Phase-3b enriched `rooms` columns (critical, safety_min/max,
--       fan_profile, role, actuation_enabled, min_off_minutes), seeded
--       BYTE-IDENTICAL to the current hardcoded Milano values
--     - widened `rooms.api_source` CHECK (adds melcloud, shelly_bridge)
--     - a COPY of the 3 stateful `tokens` rows to `:milano`-suffixed providers
--       (nude rows stay live; suffix-aware code ships Phase 5; 005 drops nude)
--
-- DESIGN DEVIATION (decided by Fabio 2026-06-20, "Path B", after two
--   independent Opus reviews converged unanimously on a CRITICAL):
--   The frozen design (design.md:31, property-model spec:26) said room-scoped
--   tables get a COMPOSITE PK (property_id, room_id). For `sonoff_bridge` we DO
--   NOT swap the PK — it stays `(room_id)` and `property_id` is a plain column.
--   WHY: the live Homey ingest (src/app/api/sensors/ingest/route.ts) upserts via
--   PostgREST `Prefer: resolution=merge-duplicates` with NO `?on_conflict=` and
--   NO property_id in the payload, so PostgREST infers the conflict target from
--   the PK *as cached*. A raw-SQL PK swap via the Management API leaves
--   PostgREST's schema cache stale → it can emit `ON CONFLICT (room_id)` against
--   a now-non-unique column → SQLSTATE 42P10 → every 2-min sensor push 502s →
--   Milano goes sensor-blind → SENSOR_FAULT → defensive heat in the EMPTY
--   apartment. That is the exact catastrophe this whole change exists to avoid.
--   The composite PK bought ZERO real uniqueness: room ids are already globally
--   unique by design (`campomarino_leone` != `leone`), so `(room_id)` is a
--   sufficient arbiter forever. Cross-write protection therefore rests on the
--   global-uniqueness invariant, which this migration ENFORCES at schema level
--   via a CHECK (sonoff_bridge_property_room_prefix_check) so it is a hard rule,
--   not a convention. See the deviation note appended to property-model spec.
--
-- NO-OP ON LIVE: every statement is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
--   / catalog-guarded, so re-applying on production changes nothing. Single-
--   statement `ADD COLUMN ... NOT NULL DEFAULT` (NOT 003's staged backfill) so
--   no concurrent insert can land a NULL in the gap. Fast-default on PG15
--   (metadata-only, no table rewrite).
--
-- APPLY: file-by-file via the Supabase Management API (the Cloudflare WAF blocks
--   payloads >~26KB). Each section below is an independently-runnable, idempotent
--   unit. Order matters only in that `properties` (§1) precedes nothing that FKs
--   to it yet, and the columns (§2-§3) precede their seeds (§5).

-- =========================================================================
-- §1 properties — per-property registry. lat/lon move OUT of the cycle
--    hardcode (cycle/route.ts:110) in Phase 8.
-- =========================================================================
create table if not exists public.properties (
  id         text not null,
  name       text not null,
  timezone   text not null,
  lat        numeric not null,
  lon        numeric not null,
  created_at timestamptz default now(),
  constraint properties_pkey primary key (id)
);

alter table public.properties enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='properties' and policyname='Allow anon all') then
    create policy "Allow anon all" on public.properties for all to anon using (true) with check (true);
  end if;
end $$;

insert into public.properties (id, name, timezone, lat, lon)
values ('milano', 'Milano', 'Europe/Rome', 45.4642, 9.1900)
on conflict (id) do nothing;

-- =========================================================================
-- §2 property_id on the relational tables (plain column, NOT NULL DEFAULT
--    'milano'). rooms PK stays (id); readings/alerts FK -> rooms(id) intact.
-- =========================================================================
alter table public.rooms          add column if not exists property_id text not null default 'milano';
alter table public.readings       add column if not exists property_id text not null default 'milano';
alter table public.agent_actions  add column if not exists property_id text not null default 'milano';
alter table public.alerts         add column if not exists property_id text not null default 'milano';

create index if not exists idx_rooms_property            on public.rooms          using btree (property_id, id);
create index if not exists idx_readings_property_time     on public.readings       using btree (property_id, room_id, measured_at desc);
create index if not exists idx_agent_actions_property     on public.agent_actions  using btree (property_id, room_id, created_at desc);
create index if not exists idx_alerts_property            on public.alerts         using btree (property_id, triggered_at desc);

-- =========================================================================
-- §3 sonoff_bridge — property_id as a PLAIN column. PK STAYS (room_id)
--    (see DESIGN DEVIATION header). The CHECK below is the enforced
--    global-uniqueness invariant that replaces the composite PK as the
--    cross-write barrier.
-- =========================================================================
alter table public.sonoff_bridge add column if not exists property_id text not null default 'milano';

create index if not exists idx_sonoff_bridge_property on public.sonoff_bridge using btree (property_id, room_id);

-- room_id <-> property prefix invariant (HARD barrier, not convention):
--   * property_id='milano'  ⇒ room_id is one of the 7 known Milano ids
--   * property_id<>'milano' ⇒ room_id is namespaced '<property_id>_...'
-- A mis-prefixed/cross-home room_id is REJECTED at write time.
do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where c.conname = 'sonoff_bridge_property_room_prefix_check' and t.relnamespace = 'public'::regnamespace
  ) then
    alter table public.sonoff_bridge
      add constraint sonoff_bridge_property_room_prefix_check
      check (
        (property_id = 'milano'
          and room_id = any (array['leone','soggiorno','camera','studio','cucina','bagno1','bagno2']::text[]))
        or (property_id <> 'milano'
          and room_id like property_id || '\_%')
      );
  end if;
end $$;

-- =========================================================================
-- §4 widen rooms.api_source CHECK to add melcloud + shelly_bridge.
--    DROP+ADD as a single statement-block so re-run / partial-run converges
--    and there is no constraint-absent window for a concurrent writer
--    (rooms is never INSERTed during a cycle anyway). Name is exactly
--    'rooms_api_source_check' (asserted in 001).
-- =========================================================================
do $$
begin
  alter table public.rooms drop constraint if exists rooms_api_source_check;
  alter table public.rooms
    add constraint rooms_api_source_check
    check (api_source = any (array['sabiana'::text, 'netatmo'::text, 'melcloud'::text, 'shelly_bridge'::text]));
end $$;

-- =========================================================================
-- §5 enriched rooms columns (Phase-3b prep; Milano code reads NONE of these
--    until 3b — every hot-path SELECT names columns explicitly, no SELECT *).
--    Defaults match the non-Nursery, standard-profile, non-critical baseline;
--    the UPDATEs below seed the Milano exceptions BYTE-IDENTICAL to the live
--    hardcoded sources:
--      safety_min/max  <- SAFETY_BOUNDS (safety.ts:43-49) leone 18/32, rest 16/35
--      critical        <- ROOM_PRIORITIES (cycle/route.ts:33) only leone true
--      fan_profile     <- state-machine.ts computeFanSpeed: camera 'silent', rest 'standard'
--      role            <- thermostat.ts: soggiorno=thermostat, cucina=reference, bagno1=sentinel (SENTINEL_ROOM)
--      actuation_enabled / min_off_minutes <- Milano fancoils actuate, 10-min cadence
-- =========================================================================
alter table public.rooms add column if not exists critical          boolean not null default false;
alter table public.rooms add column if not exists safety_min        numeric not null default 16;
alter table public.rooms add column if not exists safety_max        numeric not null default 35;
alter table public.rooms add column if not exists fan_profile       text    not null default 'standard';
alter table public.rooms add column if not exists role              text;
alter table public.rooms add column if not exists actuation_enabled boolean not null default true;
alter table public.rooms add column if not exists min_off_minutes   integer not null default 10;

-- Seed Milano exceptions (idempotent: these set absolute values).
update public.rooms set safety_min = 18, safety_max = 32, critical = true where id = 'leone'   and property_id = 'milano';
update public.rooms set fan_profile = 'silent'                              where id = 'camera'  and property_id = 'milano';
update public.rooms set role = 'thermostat'                                 where id = 'soggiorno' and property_id = 'milano';
update public.rooms set role = 'reference'                                  where id = 'cucina'    and property_id = 'milano';
update public.rooms set role = 'sentinel'                                   where id = 'bagno1'    and property_id = 'milano';

-- =========================================================================
-- §6 tokens COPY — duplicate the 3 stateful providers to ':milano'-suffixed
--    keys. Nude rows STAY LIVE (current code reads them); suffix-aware code
--    ships Phase 5; 005 drops the nude rows post-drain. Guard `NOT LIKE '%:%'`
--    prevents 'agent_state:milano:milano' on re-run. ON CONFLICT DO NOTHING
--    makes re-run a no-op. Inert until Phase 5 (nothing reads the suffixed
--    rows yet).
-- =========================================================================
insert into public.tokens (provider, data, updated_at)
select provider || ':milano', data, updated_at
from public.tokens
where provider in ('agent_state', 'setpoint_overrides', 'settings')
  and provider not like '%:%'
on conflict (provider) do nothing;
