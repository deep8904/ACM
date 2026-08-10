create table if not exists content_machine.writing_jobs (
  id text primary key,
  topic_id text not null,
  research_version integer not null check (research_version > 0),
  status text not null,
  worker_id text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  version integer not null check (version > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (topic_id, research_version)
);

create table if not exists content_machine.article_drafts (
  id text primary key,
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  research_version integer not null check (research_version > 0),
  import_hash text not null unique,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  mdx text not null,
  plain_text text not null,
  payload jsonb not null,
  provenance jsonb not null,
  created_at timestamptz not null default now(),
  unique (topic_id, draft_version)
);

create table if not exists content_machine.draft_quality_reports (
  draft_id text primary key references content_machine.article_drafts(id),
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  passed boolean not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (topic_id, draft_version)
);

create table if not exists content_machine.article_history (
  id text primary key,
  topic_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null
);

create table if not exists content_machine.writing_tasks (
  topic_id text not null,
  research_version integer not null check (research_version > 0),
  input_payload jsonb,
  files jsonb not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key (topic_id, research_version)
);
