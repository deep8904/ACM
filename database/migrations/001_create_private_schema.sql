-- Private server-side workflow schema. Never add this schema to Supabase Data API exposed schemas.
create schema if not exists content_machine;

revoke all on schema content_machine from public;
revoke all on all tables in schema content_machine from public;
alter default privileges in schema content_machine revoke all on tables from public;
alter default privileges in schema content_machine revoke all on sequences from public;

create table if not exists content_machine.schema_migrations (
  version text primary key,
  name text not null,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now(),
  execution_ms integer not null check (execution_ms >= 0)
);
