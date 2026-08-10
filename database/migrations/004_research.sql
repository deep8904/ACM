create table if not exists content_machine.research_jobs (
  id text primary key,
  event_id text not null unique references content_machine.topic_approved_events(id),
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

create table if not exists content_machine.research_sources (
  id text primary key,
  topic_id text not null,
  canonical_url text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  extracted_text text not null,
  byte_length integer not null check (byte_length >= 0 and byte_length <= 5000000),
  payload jsonb not null,
  retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (topic_id, canonical_url, content_hash)
);

create table if not exists content_machine.research_cache (
  canonical_url text primary key,
  source_id text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  text_content text not null,
  payload jsonb not null,
  fetched_at timestamptz not null,
  expires_at timestamptz
);

create table if not exists content_machine.robots_cache (
  host text primary key,
  body text not null,
  fetched_at timestamptz not null
);

create table if not exists content_machine.research_packets (
  id text primary key,
  topic_id text not null,
  approved_event_id text not null references content_machine.topic_approved_events(id),
  packet_version integer not null check (packet_version > 0),
  import_hash text,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (topic_id, packet_version),
  unique (import_hash)
);

create table if not exists content_machine.research_tasks (
  id text primary key,
  topic_id text not null,
  packet_version integer,
  import_hash text unique,
  input_payload jsonb not null,
  files jsonb not null,
  created_at timestamptz not null default now(),
  imported_at timestamptz
);
