create table if not exists content_machine.topic_queue_items (
  id text primary key,
  short_id text not null unique,
  topic_id text not null unique,
  candidate_id text not null,
  run_id text not null,
  approval_status text not null check (approval_status in ('pending','approved','rejected','cancelled','superseded')),
  trigger_state text not null,
  version integer not null check (version > 0),
  expires_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (updated_at >= created_at)
);

create table if not exists content_machine.topic_approvals (
  id text primary key,
  topic_id text not null,
  queue_item_id text references content_machine.topic_queue_items(id),
  action text not null,
  status text not null,
  telegram_update_id bigint not null,
  callback_query_id text,
  version integer not null check (version > 0),
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (topic_id, version),
  unique (telegram_update_id)
);

create table if not exists content_machine.telegram_updates (
  update_id bigint primary key check (update_id >= 0),
  callback_query_id text unique,
  status text not null check (status in ('processing','completed')),
  command_type text not null default '',
  claimed_at timestamptz not null,
  processed_at timestamptz,
  payload jsonb,
  check (processed_at is null or processed_at >= claimed_at)
);

create table if not exists content_machine.telegram_callbacks (
  callback_query_id text primary key,
  update_id bigint not null unique references content_machine.telegram_updates(update_id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists content_machine.telegram_conversations (
  chat_id text not null,
  user_id text not null,
  state text not null,
  topic_id text,
  version integer not null check (version > 0),
  expires_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists content_machine.telegram_message_index (
  short_id text primary key,
  topic_id text not null,
  chat_id text not null,
  telegram_message_id bigint not null check (telegram_message_id >= 0),
  version integer not null check (version > 0),
  payload jsonb not null,
  updated_at timestamptz not null
);

create table if not exists content_machine.topic_approved_events (
  id text primary key,
  topic_id text not null unique,
  approval_id text references content_machine.topic_approvals(id),
  status text not null check (status in ('ready','cancelled')),
  version integer not null check (version > 0),
  payload jsonb not null,
  approved_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists content_machine.topic_event_state (
  event_id text primary key references content_machine.topic_approved_events(id),
  worker_id text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  consumed_at timestamptz,
  packet_id text,
  packet_version integer check (packet_version is null or packet_version > 0),
  version integer not null default 1 check (version > 0),
  check ((consumed_at is null and packet_id is null and packet_version is null) or
         (consumed_at is not null and packet_id is not null and packet_version is not null))
);
