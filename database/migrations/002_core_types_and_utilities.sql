create or replace function content_machine.reject_immutable_change()
returns trigger language plpgsql as $$
begin
  raise exception 'immutable row in %.% cannot be changed', tg_table_schema, tg_table_name
    using errcode = '23000';
end;
$$;

create table if not exists content_machine.workflow_runs (
  id text primary key,
  started_at timestamptz not null,
  completed_at timestamptz,
  config_hash text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  check (completed_at is null or completed_at >= started_at)
);

create table if not exists content_machine.topics (
  id text primary key,
  run_id text not null references content_machine.workflow_runs(id),
  candidate_id text not null,
  origin text not null check (origin in ('ranked','manual_topic','manual_url')),
  title text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, candidate_id)
);

create table if not exists content_machine.workflow_artifacts (
  id bigint generated always as identity primary key,
  run_id text not null,
  stage text not null check (stage in ('discovery','ranking','telegram','research','writing','review','publication','social','analytics')),
  name text not null,
  media_type text not null,
  content_text text,
  payload jsonb,
  byte_length integer not null check (byte_length >= 0),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  check ((content_text is null) <> (payload is null)),
  unique (run_id, stage, name)
);

create table if not exists content_machine.ranking_history (
  id text primary key,
  run_id text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, content_hash)
);

create table if not exists content_machine.storage_migration_runs (
  id text primary key,
  source_backend text not null check (source_backend = 'file'),
  target_backend text not null check (target_backend = 'postgres'),
  source_root text not null,
  dry_run boolean not null,
  status text not null check (status in ('running','completed','failed')),
  manifest jsonb not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (completed_at is null or completed_at >= started_at)
);
