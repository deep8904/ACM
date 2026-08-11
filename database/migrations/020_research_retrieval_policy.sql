create table if not exists content_machine.research_retrieval_host_state (
  host text primary key,
  attempt_count integer not null check (attempt_count >= 0),
  window_started_at timestamptz not null,
  cooldown_until timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists content_machine.research_retrieval_outcomes (
  canonical_url text primary key,
  host text not null,
  diagnostic_code text not null check (diagnostic_code in (
    '429_retry_after','429_cooldown','robots_denied','403_forbidden',
    'alternate_official_found','no_retrievable_primary'
  )),
  http_status integer not null check (http_status between 0 and 599),
  retry_at timestamptz,
  expires_at timestamptz not null,
  recorded_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_research_retrieval_outcomes_host
  on content_machine.research_retrieval_outcomes(host, expires_at);

revoke all on content_machine.research_retrieval_host_state from public;
revoke all on content_machine.research_retrieval_outcomes from public;
