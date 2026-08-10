create table if not exists content_machine.automation_jobs (
  id text primary key check (id ~ '^automationjob_[a-f0-9]{24}$'),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  job_type text not null check (job_type in (
    'discovery', 'research', 'writing', 'editorial_review', 'revision',
    'publication', 'production_verification', 'notification', 'reconciliation'
  )),
  status text not null check (status in (
    'queued', 'running', 'succeeded', 'failed', 'retryable', 'blocked',
    'cancelled'
  )),
  topic_id text,
  parent_job_id text references content_machine.automation_jobs(id),
  lineage_key text not null,
  payload jsonb not null,
  result jsonb,
  attempt integer not null default 0 check (attempt >= 0),
  maximum_attempts integer not null default 3 check (maximum_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  failure_code text,
  failure_summary text,
  diagnostic_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  version integer not null default 1 check (version > 0),
  check ((status = 'running') = (lease_owner is not null and lease_expires_at is not null)),
  check (failure_summary is null or length(failure_summary) <= 1000)
);

create index if not exists idx_automation_jobs_claim
  on content_machine.automation_jobs (status, available_at, created_at)
  where status in ('queued', 'retryable', 'running');
create index if not exists idx_automation_jobs_topic
  on content_machine.automation_jobs (topic_id, created_at desc)
  where topic_id is not null;
create index if not exists idx_automation_jobs_lineage
  on content_machine.automation_jobs (lineage_key, created_at);

create table if not exists content_machine.automation_heartbeats (
  component text primary key check (component in ('scheduler', 'worker', 'webhook')),
  instance_id text not null,
  status text not null check (status in ('healthy', 'degraded', 'failed')),
  details jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists content_machine.llm_invocations (
  id text primary key check (id ~ '^llmcall_[a-f0-9]{24}$'),
  job_id text not null references content_machine.automation_jobs(id),
  stage text not null check (stage in ('research', 'writing', 'editorial_review', 'revision')),
  provider text not null,
  model text not null,
  provider_version text,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  response_hash text check (response_hash is null or response_hash ~ '^[a-f0-9]{64}$'),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  total_tokens integer check (total_tokens is null or total_tokens >= 0),
  status text not null check (status in ('started', 'succeeded', 'failed', 'schema_rejected')),
  error_summary text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists idx_llm_invocations_job_request
  on content_machine.llm_invocations (job_id, stage, request_hash)
  where status = 'succeeded';

revoke all on content_machine.automation_jobs from public;
revoke all on content_machine.automation_heartbeats from public;
revoke all on content_machine.llm_invocations from public;

