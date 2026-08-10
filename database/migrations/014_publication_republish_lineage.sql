create table if not exists content_machine.publication_republishes (
  id text primary key,
  source_publication_id text not null references content_machine.publications(id),
  event_id text not null references content_machine.final_approved_events(id),
  repository text not null,
  base_branch text not null,
  branch text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (repository, branch, content_hash)
);

create index if not exists idx_publication_republishes_source_publication_id
  on content_machine.publication_republishes (source_publication_id);
create index if not exists idx_publication_republishes_event_id
  on content_machine.publication_republishes (event_id);

drop trigger if exists publication_republishes_immutable
  on content_machine.publication_republishes;
create trigger publication_republishes_immutable
before update or delete on content_machine.publication_republishes
for each row execute function content_machine.reject_immutable_change();
