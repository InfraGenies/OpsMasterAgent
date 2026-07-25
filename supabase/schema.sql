-- Ops Master Agent — Supabase schema
-- Run this once in your Supabase project's SQL Editor (free tier is fine).
-- Mirrors agent-md-files/07-audit-store.md, with a `decisions` table added
-- so the approval gate has an explicit, queryable record (04-approval-gate.md
-- requires "no code path to deploy without a decision row").

create table if not exists runs (
  request_id   text primary key,
  raw_text     text not null,
  operation    text not null,
  status       text not null, -- running|awaiting_approval|deployed|failed|rolled_back|refused
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create table if not exists audit_events (
  event_id         bigint generated always as identity primary key,
  request_id       text not null references runs(request_id) on delete cascade,
  ts               timestamptz not null default now(),
  node             text not null,
  actor            text not null, -- agent|human
  input_digest     text,
  output_digest    text,
  input_json       text,
  output_json      text,
  command_executed text,
  status           text not null, -- success|failure|pending
  detail           text not null default ''
);

create index if not exists audit_events_request_id_idx on audit_events(request_id);

create table if not exists environments (
  env_id         text primary key,
  request_id     text not null references runs(request_id) on delete cascade,
  name           text not null,
  target         text not null,
  files_json     text not null,
  endpoints_json text not null,
  state          text not null -- up|down|rolled_back
);

create index if not exists environments_request_id_idx on environments(request_id);

create table if not exists decisions (
  id          bigint generated always as identity primary key,
  request_id  text not null references runs(request_id) on delete cascade,
  action      text not null, -- approve|reject|edit
  comment     text,
  actor       text not null,
  ts          timestamptz not null default now()
);

create index if not exists decisions_request_id_idx on decisions(request_id);

-- All access goes through the service-role key from the server, never the
-- browser, so RLS can stay locked down (no anon policies needed).
alter table runs enable row level security;
alter table audit_events enable row level security;
alter table environments enable row level security;
alter table decisions enable row level security;
