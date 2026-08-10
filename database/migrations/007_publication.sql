create table if not exists content_machine.publication_jobs (
  id text primary key,
  event_id text not null unique references content_machine.final_approved_events(id),
  topic_id text not null,
  status text not null,
  worker_id text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  version integer not null check (version > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists content_machine.publications (
  id text primary key,
  event_id text not null unique references content_machine.final_approved_events(id),
  topic_id text not null unique,
  commit_sha text not null,
  canonical_url text not null unique,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique,
  payload jsonb not null,
  published_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists content_machine.publication_consumptions (
  event_id text primary key references content_machine.final_approved_events(id),
  publication_id text not null unique references content_machine.publications(id),
  success_condition text not null,
  consumed_at timestamptz not null,
  payload jsonb not null
);

create table if not exists content_machine.deployment_records (
  publication_id text primary key references content_machine.publications(id),
  commit_sha text not null,
  status text not null,
  version integer not null default 1 check (version > 0),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  unique (publication_id, commit_sha)
);

create table if not exists content_machine.publication_verifications (
  publication_id text primary key references content_machine.publications(id),
  canonical_url text not null,
  verified boolean not null,
  version integer not null default 1 check (version > 0),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
