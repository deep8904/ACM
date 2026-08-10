create table if not exists content_machine.editorial_review_jobs (
  id text primary key,
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
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
  unique (topic_id, draft_version)
);

create table if not exists content_machine.editorial_reviews (
  id text primary key,
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  review_version integer not null check (review_version > 0),
  import_hash text not null unique,
  payload jsonb not null,
  deterministic_report jsonb not null,
  provenance jsonb not null,
  created_at timestamptz not null default now(),
  unique (topic_id, draft_version, review_version)
);

create table if not exists content_machine.editorial_issues (
  id text primary key,
  review_id text not null references content_machine.editorial_reviews(id),
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  review_version integer not null check (review_version > 0),
  severity text not null,
  resolved_at timestamptz,
  revised_draft_version integer check (revised_draft_version is null or revised_draft_version > 0),
  payload jsonb not null
);

create table if not exists content_machine.review_tasks (
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  input_payload jsonb,
  files jsonb not null,
  created_at timestamptz not null default now(),
  primary key (topic_id, draft_version)
);

create table if not exists content_machine.revision_tasks (
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  input_payload jsonb,
  files jsonb not null,
  request_payload jsonb,
  resolution_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (topic_id, draft_version)
);

create table if not exists content_machine.draft_previews (
  id text primary key,
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  html text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  superseded_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (topic_id, draft_version)
);

create table if not exists content_machine.final_approvals (
  id text primary key,
  short_id text not null unique,
  topic_id text not null,
  draft_version integer not null check (draft_version > 0),
  review_version integer not null check (review_version > 0),
  status text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (topic_id, draft_version, review_version)
);

create table if not exists content_machine.final_approved_events (
  id text primary key,
  topic_id text not null unique,
  approval_id text not null unique references content_machine.final_approvals(id),
  draft_version integer not null check (draft_version > 0),
  review_version integer not null check (review_version > 0),
  status text not null,
  version integer not null check (version > 0),
  scheduled_for timestamptz,
  snapshot_hash text not null unique check (snapshot_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists content_machine.final_conversations (
  chat_id text not null,
  user_id text not null,
  state text not null,
  topic_id text,
  version integer not null check (version > 0),
  expires_at timestamptz not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
