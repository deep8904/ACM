-- Harden the immutable-row trigger function and cover foreign-key access paths
-- identified by the Supabase database advisors after the initial deployment.
create or replace function content_machine.reject_immutable_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'immutable row in %.% cannot be changed', tg_table_schema, tg_table_name
    using errcode = '23000';
end;
$$;

create index if not exists idx_editorial_issues_review_id
  on content_machine.editorial_issues (review_id);
create index if not exists idx_research_packets_approved_event_id
  on content_machine.research_packets (approved_event_id);
create index if not exists idx_social_approvals_item_id
  on content_machine.social_approvals (item_id);
create index if not exists idx_social_quality_reports_item_id
  on content_machine.social_quality_reports (item_id);
create index if not exists idx_topic_approvals_queue_item_id
  on content_machine.topic_approvals (queue_item_id);
create index if not exists idx_topic_approved_events_approval_id
  on content_machine.topic_approved_events (approval_id);
