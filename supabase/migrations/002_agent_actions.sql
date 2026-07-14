-- Agent actions log for ThermoLeo intelligent controller
-- Tracks every setpoint, fan, and mode change with reasoning and stability metrics

create table if not exists agent_actions (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  room_id       text not null,
  action_type   text not null check (action_type in ('setpoint_change', 'fan_change', 'mode_change', 'mode_change_on', 'mode_change_off', 'target_change')),
  old_value     text,
  new_value     text,
  reason        text,
  stability_score double precision,
  error_magnitude double precision,
  trend         double precision
);

-- Index for dashboard queries: recent actions per room
create index if not exists idx_agent_actions_room_created
  on agent_actions (room_id, created_at desc);

-- Index for rate-limit lookups: actions in last hour per room
create index if not exists idx_agent_actions_room_type_created
  on agent_actions (room_id, action_type, created_at desc);

-- RLS: anon read + anon insert (the agent writes the action log via the anon key).
-- Policy names + roles match the live DB (and migration 001), so on a fresh DB
-- where 001 already created these, the guards below make this a clean no-op.
-- (Supabase is PG15 → no CREATE POLICY ... IF NOT EXISTS; guard with DO $$.)
alter table agent_actions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_actions' and policyname='Allow anon read') then
    create policy "Allow anon read" on agent_actions for select to anon using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_actions' and policyname='Allow anon insert') then
    create policy "Allow anon insert" on agent_actions for insert to anon with check (true);
  end if;
end $$;
