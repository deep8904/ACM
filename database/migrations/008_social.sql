create table if not exists content_machine.social_generation_jobs (
  id text primary key,
  publication_id text not null unique references content_machine.publications(id),
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

create table if not exists content_machine.social_packages (
  id text primary key,
  publication_id text not null references content_machine.publications(id),
  package_version integer not null check (package_version > 0),
  publication_content_hash text not null check (publication_content_hash ~ '^[a-f0-9]{64}$'),
  import_hash text not null unique,
  payload jsonb not null,
  provenance jsonb not null,
  created_at timestamptz not null default now(),
  unique (publication_id, package_version)
);

create table if not exists content_machine.social_items (
  id text primary key,
  package_id text not null references content_machine.social_packages(id),
  platform text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  unique (package_id, platform, id)
);

create table if not exists content_machine.social_quality_reports (
  package_id text not null references content_machine.social_packages(id),
  item_id text not null references content_machine.social_items(id),
  passed boolean not null,
  payload jsonb not null,
  primary key (package_id, item_id)
);

create table if not exists content_machine.social_approvals (
  package_id text not null references content_machine.social_packages(id),
  item_id text not null references content_machine.social_items(id),
  item_content_hash text not null check (item_content_hash ~ '^[a-f0-9]{64}$'),
  status text not null,
  scheduled_for timestamptz,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (package_id, item_id)
);

create table if not exists content_machine.social_history (
  id text primary key,
  publication_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null
);

create table if not exists content_machine.social_exports (
  id text primary key,
  publication_id text not null,
  package_version integer not null check (package_version > 0),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  files jsonb not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (publication_id, package_version, id)
);

create table if not exists content_machine.social_tasks (
  publication_id text not null,
  package_version integer not null check (package_version > 0),
  input_payload jsonb,
  files jsonb not null,
  created_at timestamptz not null default now(),
  primary key (publication_id, package_version)
);

create table if not exists content_machine.social_posted_records (
  id text primary key,
  publication_id text not null,
  platform text not null,
  post_url text unique,
  payload jsonb not null,
  posted_at timestamptz not null,
  unique (publication_id, platform)
);

create table if not exists content_machine.social_revisions (
  publication_id text not null,
  package_version integer not null check (package_version > 0),
  files jsonb not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (publication_id, package_version)
);

create table if not exists content_machine.social_conversations (
  chat_id text not null,
  user_id text not null,
  state text not null,
  publication_id text,
  version integer not null check (version > 0),
  expires_at timestamptz not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
