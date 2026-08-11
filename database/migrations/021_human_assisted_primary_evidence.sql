create table if not exists content_machine.research_source_evidence_records (
  id text primary key check (id ~ '^evidence_[a-f0-9]{24}$'),
  remediation_id text not null,
  topic_id text not null,
  event_id text not null references content_machine.topic_approved_events(id),
  job_id text not null references content_machine.automation_jobs(id),
  base_packet_version integer not null check (base_packet_version > 0),
  packet_version integer not null check (packet_version > base_packet_version),
  source_id text not null check (source_id ~ '^source_[a-f0-9]{24}$'),
  source_content_hash text not null check (source_content_hash ~ '^[a-f0-9]{64}$'),
  canonical_url text not null,
  publisher_owner text not null,
  acquisition_mode text not null check (
    acquisition_mode = 'human_assisted_primary_evidence'
  ),
  operator_actor_hash text not null check (operator_actor_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  file_hash text check (file_hash is null or file_hash ~ '^[a-f0-9]{64}$'),
  evidence_text text not null check (
    octet_length(evidence_text) between 1 and 20000
  ),
  provenance_statement text not null,
  original_diagnostic_id text not null check (original_diagnostic_id ~ '^diag_[a-f0-9]{16}$'),
  original_failure_code text not null check (original_failure_code in (
    '429_retry_after','429_cooldown','robots_denied','403_forbidden','retrieval'
  )),
  payload jsonb not null,
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (remediation_id, evidence_hash),
  unique (topic_id, packet_version),
  foreign key (topic_id, base_packet_version)
    references content_machine.research_packets(topic_id, packet_version),
  foreign key (topic_id, packet_version)
    references content_machine.research_packets(topic_id, packet_version)
);

create index if not exists idx_research_source_evidence_topic
  on content_machine.research_source_evidence_records(topic_id, created_at);

drop trigger if exists research_source_evidence_records_immutable
  on content_machine.research_source_evidence_records;
create trigger research_source_evidence_records_immutable
before update or delete on content_machine.research_source_evidence_records
for each row execute function content_machine.reject_immutable_change();

revoke all on content_machine.research_source_evidence_records from public;

alter table content_machine.research_remediation_conversations
  drop constraint if exists research_remediation_conversations_state_check;
alter table content_machine.research_remediation_conversations
  add constraint research_remediation_conversations_state_check check (state in (
    'blocked','awaiting_url','awaiting_classification','awaiting_evidence',
    'evidence_review','awaiting_provenance','queued','cancelled','superseded','failed'
  ));
