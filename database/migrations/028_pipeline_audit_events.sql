create table if not exists content_machine.pipeline_audit_events (
  id text primary key check (id ~ '^pipelineaudit_[a-f0-9]{24}$'),
  job_id text not null references content_machine.automation_jobs(id),
  stage text not null check (stage in ('research', 'writing', 'editorial_review', 'revision')),
  event_type text not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text not null check (output_hash ~ '^[a-f0-9]{64}$'),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (job_id, event_type, output_hash)
);

create index if not exists idx_pipeline_audit_events_job
  on content_machine.pipeline_audit_events (job_id, created_at);

revoke all on content_machine.pipeline_audit_events from public;
