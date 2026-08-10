create table if not exists content_machine.social_distribution_plans (
  id text primary key,
  publication_id text not null references content_machine.production_publication_artifacts(id),
  publication_content_hash text not null check (publication_content_hash ~ '^[a-f0-9]{64}$'),
  status text not null,
  selection_revision integer not null check (selection_revision >= 0),
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (publication_id, publication_content_hash)
);

create table if not exists content_machine.social_distribution_events (
  id text primary key,
  plan_id text not null references content_machine.social_distribution_plans(id),
  sequence integer not null check (sequence > 0),
  event_type text not null,
  callback_query_id text unique,
  payload jsonb not null,
  created_at timestamptz not null,
  unique (plan_id, sequence)
);

create table if not exists content_machine.social_assets (
  id text primary key,
  plan_id text not null references content_machine.social_distribution_plans(id),
  package_id text not null references content_machine.social_packages(id),
  platform text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  media_type text not null check (media_type = 'image/png'),
  bytes bytea not null,
  payload jsonb not null,
  created_at timestamptz not null,
  unique (plan_id, content_hash)
);

create index if not exists social_distribution_plans_publication_idx
  on content_machine.social_distribution_plans(publication_id, updated_at desc);
create index if not exists social_assets_plan_idx
  on content_machine.social_assets(plan_id, platform, id);

create trigger social_distribution_events_immutable
before update or delete on content_machine.social_distribution_events
for each row execute function content_machine.reject_immutable_change();

create trigger social_assets_immutable
before update or delete on content_machine.social_assets
for each row execute function content_machine.reject_immutable_change();

alter table content_machine.social_distribution_plans enable row level security;
alter table content_machine.social_distribution_events enable row level security;
alter table content_machine.social_assets enable row level security;
revoke all on content_machine.social_distribution_plans from public;
revoke all on content_machine.social_distribution_events from public;
revoke all on content_machine.social_assets from public;
