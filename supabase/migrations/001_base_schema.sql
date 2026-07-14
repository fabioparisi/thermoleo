-- Migration 001: Base schema (live snapshot, schema-only)
--
-- WHAT: A faithful, CREATE-guarded reconstruction of the 6 live ThermoLeo tables
--   as they exist in the production Supabase project:
--     tokens, rooms, readings, agent_actions, alerts, sonoff_bridge
--   captured 2026-06-20 via the Supabase Management API
--   (POST /v1/projects/{ref}/database/query introspection of
--    information_schema + pg_catalog), since the project is not CLI-linked and
--    a `pg_dump` would require the Postgres password.
--
-- WHY: Commit the live schema as code so a from-scratch DB reproduces production.
--   Earlier migrations (002, 003) and several hand-applied ALTERs had drifted the
--   live schema ahead of what was tracked; this file is the authoritative base.
--   It captures what a CREATE-TABLE skeleton would silently drop:
--     - tokens PRIMARY KEY (provider)  ← the optimistic-concurrency CAS and the
--       merge-duplicates upserts depend on provider being unique
--     - GENERATED ALWAYS AS IDENTITY on the 3 bigint surrogate keys
--     - every CHECK constraint (action_type 6-value, severity, api_source)
--     - the foreign keys readings/alerts -> rooms(id)
--     - RLS enabled on all 6 tables + every policy, incl. allow_all_sonoff_bridge
--       (anon ingest writes 401 without it)
--
-- NO-OP ON LIVE: every object is `IF NOT EXISTS` / `DO $$ ... IF NOT EXISTS`
--   guarded, so applying this on the existing production DB changes nothing and
--   never disturbs Milano's OFF state. It is meant to run first only on a fresh DB.
--
-- NOTE ON DRIFT: the live `rooms` table already carries the topology-enrichment
--   columns (api_source, device_id, icon, priority) and target_temp_min/max that
--   later phases reference; they are reproduced here as live. The `rooms.api_source`
--   CHECK is currently ('sabiana','netatmo') — migration 004 widens it for
--   melcloud/shelly_bridge. The `agent_actions.action_type` CHECK is already the
--   live 6-value set; committed migration 002 is reconciled to match.

-- =========================================================================
-- tokens — stateful providers + vendor OAuth tokens. PK on provider is
-- load-bearing for the CAS upserts.
-- =========================================================================
create table if not exists public.tokens (
  provider   text not null,
  data       jsonb not null,
  updated_at timestamptz default now(),
  constraint tokens_pkey primary key (provider)
);

-- =========================================================================
-- rooms — topology. Live already includes enrichment columns.
-- =========================================================================
create table if not exists public.rooms (
  id              text not null,
  name            text not null,
  api_source      text not null,
  device_id       text,
  icon            text,
  priority        integer default 0,
  target_temp_min numeric(3,1) default 19.0,
  target_temp_max numeric(3,1) default 23.0,
  target_temp     numeric(3,1) not null default 22.0,
  target_winter   numeric not null default 21.0,
  target_summer   numeric not null default 26.0,
  constraint rooms_pkey primary key (id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where c.conname = 'rooms_api_source_check' and t.relnamespace = 'public'::regnamespace
  ) then
    alter table public.rooms
      add constraint rooms_api_source_check
      check (api_source = any (array['sabiana'::text, 'netatmo'::text]));
  end if;
end $$;

-- =========================================================================
-- readings — per-room time series. FK -> rooms(id).
-- =========================================================================
create table if not exists public.readings (
  id                   bigint generated always as identity,
  room_id              text not null,
  measured_at          timestamptz not null default now(),
  temperature          numeric(4,1),
  setpoint             numeric(4,1),
  humidity             integer,
  fan_speed            numeric(3,1),
  mode                 text,
  heating_active       boolean,
  outdoor_temp         numeric(4,1),
  outdoor_compensation numeric(3,1),
  constraint readings_pkey primary key (id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where c.conname = 'readings_room_id_fkey' and t.relnamespace = 'public'::regnamespace
  ) then
    alter table public.readings
      add constraint readings_room_id_fkey
      foreign key (room_id) references public.rooms(id);
  end if;
end $$;

create index if not exists idx_readings_room_time
  on public.readings using btree (room_id, measured_at desc);

-- =========================================================================
-- agent_actions — change log. action_type CHECK is the live 6-value set.
-- =========================================================================
create table if not exists public.agent_actions (
  id              bigint generated always as identity,
  created_at      timestamptz not null default now(),
  room_id         text not null,
  action_type     text not null,
  old_value       text,
  new_value       text,
  reason          text,
  stability_score double precision,
  error_magnitude double precision,
  trend           double precision,
  constraint agent_actions_pkey primary key (id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where c.conname = 'agent_actions_action_type_check' and t.relnamespace = 'public'::regnamespace
  ) then
    alter table public.agent_actions
      add constraint agent_actions_action_type_check
      check (action_type = any (array[
        'setpoint_change'::text,
        'fan_change'::text,
        'mode_change'::text,
        'mode_change_on'::text,
        'mode_change_off'::text,
        'target_change'::text
      ]));
  end if;
end $$;

create index if not exists idx_agent_actions_room_created
  on public.agent_actions using btree (room_id, created_at desc);
create index if not exists idx_agent_actions_room_type_created
  on public.agent_actions using btree (room_id, action_type, created_at desc);

-- =========================================================================
-- alerts — surfaced anomalies. FK -> rooms(id), severity CHECK.
-- =========================================================================
create table if not exists public.alerts (
  id           bigint generated always as identity,
  room_id      text,
  alert_type   text not null,
  severity     text not null,
  message      text not null,
  triggered_at timestamptz default now(),
  resolved_at  timestamptz,
  notified_via text[],
  constraint alerts_pkey primary key (id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where c.conname = 'alerts_severity_check' and t.relnamespace = 'public'::regnamespace
  ) then
    alter table public.alerts
      add constraint alerts_severity_check
      check (severity = any (array['info'::text, 'warning'::text, 'critical'::text]));
  end if;
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where c.conname = 'alerts_room_id_fkey' and t.relnamespace = 'public'::regnamespace
  ) then
    alter table public.alerts
      add constraint alerts_room_id_fkey
      foreign key (room_id) references public.rooms(id);
  end if;
end $$;

create index if not exists idx_alerts_room
  on public.alerts using btree (room_id, triggered_at desc);

-- =========================================================================
-- sonoff_bridge — Homey-pushed sensor mirror. PK on room_id today.
-- =========================================================================
create table if not exists public.sonoff_bridge (
  room_id      text not null,
  temperature  numeric(4,1) not null,
  humidity     numeric(4,1),
  last_changed timestamptz,
  updated_at   timestamptz default now(),
  constraint sonoff_bridge_pkey primary key (room_id)
);

create index if not exists idx_sonoff_bridge_updated
  on public.sonoff_bridge using btree (updated_at);

-- =========================================================================
-- RLS — enabled on all 6, with the live policies. The agent uses the anon
-- key for ingest/read; allow_all_sonoff_bridge is required or anon writes 401.
-- =========================================================================
alter table public.tokens        enable row level security;
alter table public.rooms         enable row level security;
alter table public.readings      enable row level security;
alter table public.agent_actions enable row level security;
alter table public.alerts        enable row level security;
alter table public.sonoff_bridge enable row level security;

do $$
begin
  -- tokens: anon ALL
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='tokens' and policyname='Allow anon all') then
    create policy "Allow anon all" on public.tokens for all to anon using (true) with check (true);
  end if;

  -- rooms: anon ALL
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='rooms' and policyname='Allow anon all') then
    create policy "Allow anon all" on public.rooms for all to anon using (true) with check (true);
  end if;

  -- readings: anon read + anon insert
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='readings' and policyname='Allow anon read') then
    create policy "Allow anon read" on public.readings for select to anon using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='readings' and policyname='Allow anon insert') then
    create policy "Allow anon insert" on public.readings for insert to anon with check (true);
  end if;

  -- agent_actions: anon read + anon insert
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_actions' and policyname='Allow anon read') then
    create policy "Allow anon read" on public.agent_actions for select to anon using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_actions' and policyname='Allow anon insert') then
    create policy "Allow anon insert" on public.agent_actions for insert to anon with check (true);
  end if;

  -- alerts: anon read + anon insert
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='alerts' and policyname='Allow anon read') then
    create policy "Allow anon read" on public.alerts for select to anon using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='alerts' and policyname='Allow anon insert') then
    create policy "Allow anon insert" on public.alerts for insert to anon with check (true);
  end if;

  -- sonoff_bridge: public ALL (the load-bearing anon-ingest policy)
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sonoff_bridge' and policyname='allow_all_sonoff_bridge') then
    create policy "allow_all_sonoff_bridge" on public.sonoff_bridge for all to public using (true) with check (true);
  end if;
end $$;
