create index if not exists idx_queue_status_updated on content_machine.topic_queue_items (approval_status, updated_at);
create index if not exists idx_queue_expires on content_machine.topic_queue_items (expires_at) where expires_at is not null;
create index if not exists idx_approved_events_status on content_machine.topic_approved_events (status, approved_at);
create index if not exists idx_topic_event_lease on content_machine.topic_event_state (lease_expires_at) where consumed_at is null;
create index if not exists idx_research_jobs_status_lease on content_machine.research_jobs (status, lease_expires_at);
create index if not exists idx_research_sources_topic on content_machine.research_sources (topic_id, retrieved_at);
create index if not exists idx_research_packets_topic_version on content_machine.research_packets (topic_id, packet_version desc);
create index if not exists idx_writing_jobs_status_lease on content_machine.writing_jobs (status, lease_expires_at);
create index if not exists idx_article_drafts_topic_version on content_machine.article_drafts (topic_id, draft_version desc);
create index if not exists idx_review_jobs_status_lease on content_machine.editorial_review_jobs (status, lease_expires_at);
create index if not exists idx_reviews_topic_draft_version on content_machine.editorial_reviews (topic_id, draft_version, review_version desc);
create index if not exists idx_issues_open on content_machine.editorial_issues (topic_id, draft_version, review_version) where resolved_at is null;
create index if not exists idx_final_events_due on content_machine.final_approved_events (scheduled_for, status);
create index if not exists idx_publication_jobs_status_lease on content_machine.publication_jobs (status, lease_expires_at);
create index if not exists idx_publications_published on content_machine.publications (published_at desc);
create index if not exists idx_social_jobs_status_lease on content_machine.social_generation_jobs (status, lease_expires_at);
create index if not exists idx_social_packages_publication_version on content_machine.social_packages (publication_id, package_version desc);
create index if not exists idx_social_approvals_status_schedule on content_machine.social_approvals (status, scheduled_for);
create index if not exists idx_article_metrics_publication_observed on content_machine.article_metrics (publication_id, observed_at desc);
create index if not exists idx_social_metrics_publication_observed on content_machine.social_metrics (publication_id, observed_at desc);
create index if not exists idx_insight_actions_insight_created on content_machine.insight_actions (insight_id, created_at);
create index if not exists idx_analytics_imports_imported on content_machine.analytics_imports (imported_at);

drop trigger if exists research_packets_immutable on content_machine.research_packets;
create trigger research_packets_immutable before update or delete on content_machine.research_packets
for each row execute function content_machine.reject_immutable_change();
drop trigger if exists article_drafts_immutable on content_machine.article_drafts;
create trigger article_drafts_immutable before update or delete on content_machine.article_drafts
for each row execute function content_machine.reject_immutable_change();
drop trigger if exists editorial_reviews_immutable on content_machine.editorial_reviews;
create trigger editorial_reviews_immutable before update or delete on content_machine.editorial_reviews
for each row execute function content_machine.reject_immutable_change();
drop trigger if exists social_packages_immutable on content_machine.social_packages;
create trigger social_packages_immutable before update or delete on content_machine.social_packages
for each row execute function content_machine.reject_immutable_change();
drop trigger if exists performance_snapshots_immutable on content_machine.performance_snapshots;
create trigger performance_snapshots_immutable before update or delete on content_machine.performance_snapshots
for each row execute function content_machine.reject_immutable_change();
drop trigger if exists editorial_reports_immutable on content_machine.editorial_reports;
create trigger editorial_reports_immutable before update or delete on content_machine.editorial_reports
for each row execute function content_machine.reject_immutable_change();

comment on schema content_machine is 'Private AI Content Machine workflow state. Never expose through browser/Data API schemas.';
