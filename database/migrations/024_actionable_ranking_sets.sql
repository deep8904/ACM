create table if not exists content_machine.ranking_sets (
  run_id text primary key,
  origin text not null check (origin in ('scheduled','manual_test','other')),
  status text not null check (status in ('actionable','empty','superseded')),
  eligible_count integer not null check (eligible_count >= 0),
  display_count integer not null check (display_count >= 0),
  ranked_at timestamptz not null,
  activated_at timestamptz,
  superseded_at timestamptz,
  superseded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'actionable' and activated_at is not null and superseded_at is null and superseded_by is null)
    or (status = 'empty' and activated_at is null and superseded_at is null and superseded_by is null)
    or (status = 'superseded' and superseded_at is not null and superseded_by is not null))
);

create unique index if not exists uq_ranking_sets_one_actionable
  on content_machine.ranking_sets ((status)) where status='actionable';
create index if not exists idx_ranking_sets_ranked_at
  on content_machine.ranking_sets (ranked_at desc,run_id desc);

revoke all on content_machine.ranking_sets from public;
