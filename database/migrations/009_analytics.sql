create table if not exists content_machine.analytics_sources (
  id text primary key,
  provider text not null,
  enabled boolean not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists content_machine.analytics_sync_jobs (
  id text primary key,
  status text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  version integer not null default 1 check (version > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_end >= window_start)
);

create table if not exists content_machine.article_metrics (
  id text primary key,
  publication_id text not null,
  provider text not null,
  observed_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  import_hash text not null,
  payload jsonb not null,
  unique (publication_id, provider, window_start, window_end, import_hash),
  check (window_end >= window_start)
);

create table if not exists content_machine.social_metrics (
  id text primary key,
  publication_id text not null,
  platform text not null,
  observed_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  import_hash text not null,
  payload jsonb not null,
  unique (publication_id, platform, window_start, window_end, import_hash),
  check (window_end >= window_start)
);

create table if not exists content_machine.performance_snapshots (
  id text primary key,
  publication_id text not null,
  period text not null,
  snapshot_hash text not null unique check (snapshot_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (publication_id, period)
);

create table if not exists content_machine.editorial_insights (
  id text primary key,
  insight_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists content_machine.insight_actions (
  id text primary key,
  insight_id text not null references content_machine.editorial_insights(id),
  action text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists content_machine.editorial_reports (
  id text primary key,
  period text not null,
  report_hash text not null unique check (report_hash ~ '^[a-f0-9]{64}$'),
  markdown text not null,
  files jsonb not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists content_machine.analytics_imports (
  id text primary key,
  import_hash text not null unique check (import_hash ~ '^[a-f0-9]{64}$'),
  source_type text not null,
  payload jsonb not null,
  imported_at timestamptz not null
);

create table if not exists content_machine.analytics_tasks (
  report_id text primary key,
  files jsonb not null,
  analysis_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
