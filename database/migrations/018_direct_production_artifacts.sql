alter table content_machine.production_publication_artifacts
  alter column republish_id drop not null;

comment on column content_machine.production_publication_artifacts.republish_id is
  'Legacy fixture-republish lineage. Null for direct, exact-approved production publications.';

create unique index if not exists idx_production_publication_artifacts_direct_source
  on content_machine.production_publication_artifacts (source_publication_id)
  where republish_id is null;

