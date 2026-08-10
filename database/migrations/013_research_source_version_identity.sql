-- Research source IDs are stable per topic and canonical URL, while the file
-- repository preserves each retrieved content hash as a distinct immutable
-- source artifact. Key PostgreSQL rows by the same observable identity.
alter table content_machine.research_sources
  drop constraint research_sources_pkey,
  add constraint research_sources_pkey primary key (id, content_hash);

comment on constraint research_sources_pkey on content_machine.research_sources is
  'Stable source identity plus retrieved content version; topic, URL, and content hash remain independently unique.';
