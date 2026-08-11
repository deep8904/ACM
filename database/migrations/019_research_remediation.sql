create table if not exists content_machine.research_remediation_conversations (
  id text primary key check (id ~ '^remediation_[a-f0-9]{24}$'),
  short_id text not null unique check (short_id ~ '^[a-f0-9]{12}$'),
  chat_id text not null,
  user_id text not null,
  topic_id text not null,
  event_id text not null references content_machine.topic_approved_events(id),
  job_id text not null references content_machine.automation_jobs(id),
  packet_version integer not null check (packet_version > 0),
  state text not null check (state in (
    'blocked','awaiting_url','awaiting_classification','queued',
    'cancelled','superseded','failed'
  )),
  reason text not null,
  version integer not null check (version > 0),
  expires_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (chat_id, user_id)
);

create index if not exists idx_research_remediation_topic
  on content_machine.research_remediation_conversations(topic_id, updated_at desc);

create table if not exists content_machine.research_remediation_events (
  id text primary key check (id ~ '^remediationevent_[a-f0-9]{24}$'),
  remediation_id text not null,
  topic_id text not null,
  job_id text not null,
  action text not null,
  diagnostic_id text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_research_remediation_events_topic
  on content_machine.research_remediation_events(topic_id, created_at);

revoke all on content_machine.research_remediation_conversations from public;
revoke all on content_machine.research_remediation_events from public;
