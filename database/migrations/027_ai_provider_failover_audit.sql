alter table content_machine.llm_invocations
  add column if not exists attempt_index integer not null default 1
    check (attempt_index > 0),
  add column if not exists fallback_used boolean not null default false,
  add column if not exists fallback_reason text,
  add column if not exists failure_reason text;

create index if not exists idx_llm_invocations_provider_failures
  on content_machine.llm_invocations (provider, failure_reason, created_at desc)
  where status = 'failed';

revoke all on content_machine.llm_invocations from public;
