-- =============================================================================
-- LOCAL TEST HARNESS ONLY. NEVER run this in Supabase.
-- =============================================================================
-- Recreates the parts of a fresh Supabase project that the migrations depend
-- on, inside an in-memory PGlite database:
--   * the anon / authenticated / service_role API roles
--   * a minimal auth schema (auth.users, auth.uid())
--   * Supabase's default privileges, which grant ALL on new public objects to
--     the API roles. This is what makes migration 002's REVOKEs necessary.
--   * the supabase_realtime publication
-- =============================================================================

create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id           uuid primary key,
  instance_id  uuid,
  aud          text,
  role         text,
  email        text unique,
  created_at   timestamptz default now()
);

-- Same definition as Supabase's auth.uid(). The nullif() around each setting
-- matters: once a custom setting has been used in a session, PostgreSQL keeps
-- it defined as '' afterwards, and ''::jsonb would fail.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase default privileges for objects postgres creates in public
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create publication supabase_realtime;

-- Minimal Supabase Realtime schema (Broadcast from Database + Authorization).
-- Client roles get broad table privileges on purpose: tests must prove that
-- RLS policies (not missing grants) decide who can receive or send.
create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;

create table realtime.messages (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null,
  extension   text not null,
  payload     jsonb,
  event       text,
  private     boolean default false,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert, update, delete on realtime.messages to anon, authenticated, service_role;

-- Realtime sets this setting to the channel name when authorizing a join
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
grant execute on function realtime.topic() to anon, authenticated, service_role;

-- Mirrors the live Supabase definition (verified from the project's catalog):
-- adds a random message id to the payload when it has none, uses the same id
-- for the row, sets realtime.topic locally, and swallows errors as a warning.
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language plpgsql as $$
declare
  generated_id uuid;
  final_payload jsonb;
begin
  begin
    generated_id := gen_random_uuid();
    if payload ? 'id' then
      final_payload := payload;
    else
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    end if;
    execute format('set local realtime.topic to %L', topic);
    insert into realtime.messages (id, payload, event, topic, private, extension)
    values (generated_id, final_payload, event, topic, private, 'broadcast');
  exception when others then
    raise warning 'WarnSendingBroadcastMessage: %', sqlerrm;
  end;
end;
$$;
