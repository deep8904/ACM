create table if not exists content_machine.production_publication_artifacts (
  id text primary key check (id ~ '^publication_[a-f0-9]{24}$'),
  republish_id text not null unique references content_machine.publication_republishes(id),
  source_publication_id text not null references content_machine.publications(id),
  event_id text not null references content_machine.final_approved_events(id),
  repository text not null,
  production_commit_sha text not null check (production_commit_sha ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  canonical_url text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  deployment_provider text not null check (deployment_provider = 'vercel_git'),
  deployment_status text not null check (deployment_status = 'ready'),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_production_publication_artifacts_source
  on content_machine.production_publication_artifacts (source_publication_id, verified_at desc);
create index if not exists idx_production_publication_artifacts_event
  on content_machine.production_publication_artifacts (event_id, verified_at desc);

drop trigger if exists production_publication_artifacts_immutable
  on content_machine.production_publication_artifacts;
create trigger production_publication_artifacts_immutable
before update or delete on content_machine.production_publication_artifacts
for each row execute function content_machine.reject_immutable_change();

alter table content_machine.social_generation_jobs
  drop constraint if exists social_generation_jobs_publication_id_fkey;
alter table content_machine.social_packages
  drop constraint if exists social_packages_publication_id_fkey;

create or replace function content_machine.require_publication_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, content_machine
as $$
begin
  if not exists (
    select 1 from content_machine.publications where id = new.publication_id
  ) and not exists (
    select 1 from content_machine.production_publication_artifacts
    where id = new.publication_id
  ) then
    raise exception 'Unknown publication identity: %', new.publication_id
      using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists social_generation_jobs_publication_identity
  on content_machine.social_generation_jobs;
create trigger social_generation_jobs_publication_identity
before insert or update of publication_id on content_machine.social_generation_jobs
for each row execute function content_machine.require_publication_identity();

drop trigger if exists social_packages_publication_identity
  on content_machine.social_packages;
create trigger social_packages_publication_identity
before insert or update of publication_id on content_machine.social_packages
for each row execute function content_machine.require_publication_identity();
