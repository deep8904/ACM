-- Article revisions intentionally retain the logical draft ID while advancing
-- draft_version. Key immutable drafts and their quality reports by both values
-- so successive versions can coexist without rewriting historical rows.

alter table content_machine.draft_quality_reports
  drop constraint draft_quality_reports_draft_id_fkey;

alter table content_machine.draft_quality_reports
  drop constraint draft_quality_reports_pkey;

alter table content_machine.article_drafts
  drop constraint article_drafts_pkey;

alter table content_machine.article_drafts
  add constraint article_drafts_pkey primary key (id, draft_version);

alter table content_machine.draft_quality_reports
  add constraint draft_quality_reports_pkey primary key (draft_id, draft_version);

alter table content_machine.draft_quality_reports
  add constraint draft_quality_reports_draft_id_draft_version_fkey
  foreign key (draft_id, draft_version)
  references content_machine.article_drafts (id, draft_version);
