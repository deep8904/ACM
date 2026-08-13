create table if not exists content_machine.discovery_schedule_state (
  id text primary key check (id = 'primary'),
  last_successful_at timestamptz,
  last_window_start timestamptz,
  last_window_end timestamptz,
  last_run_id text,
  updated_at timestamptz not null default now(),
  check (last_window_start is null or last_window_end is null or last_window_end >= last_window_start)
);

insert into content_machine.discovery_schedule_state(id) values ('primary')
on conflict(id) do nothing;

create table if not exists content_machine.editorial_interests (
  id text primary key check (id ~ '^interest_[a-f0-9]{24}$'),
  short_id text not null unique check (short_id ~ '^[a-f0-9]{12}$'),
  name text not null,
  normalized_name text not null unique,
  keywords jsonb not null,
  status text not null check (status in ('enabled','disabled','removed')),
  is_default boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create table if not exists content_machine.editorial_interest_events (
  id bigint generated always as identity primary key,
  interest_id text not null references content_machine.editorial_interests(id),
  action text not null check (action in ('seeded','added','enabled','disabled','removed')),
  actor_chat_id text,
  actor_user_id text,
  telegram_update_id bigint,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (interest_id, action, telegram_update_id)
);

create index if not exists idx_editorial_interest_events_interest
  on content_machine.editorial_interest_events(interest_id, created_at desc);

with defaults(id,short_id,name,normalized_name,keywords) as (values
  ('interest_f5ac3e1b0a5fe6d3c773c18d','f5ac3e1b0a5f','New technology / computer & design technology','new technology / computer & design technology',
    '["computer technology","design technology","creator technology","figma","display technology","laptop"]'::jsonb),
  ('interest_c3d093bb41042881e02c25c9','c3d093bb4104','Product reviews / hardware','product reviews / hardware',
    '["hardware","keyboard","monitor","computer","laptop","buying analysis"]'::jsonb),
  ('interest_116d02695fc232c4761b0977','116d02695fc2','Gaming / game design / game-engine news','gaming / game design / game-engine news',
    '["gaming","nintendo","game design","game development","game engine","unity","unreal engine"]'::jsonb),
  ('interest_b8d3227f2b89ac42452334f1','b8d3227f2b89','Software / AI news','software / ai news',
    '["software","artificial intelligence","ai","claude","openai","developer tools","model release"]'::jsonb)
)
insert into content_machine.editorial_interests
  (id,short_id,name,normalized_name,keywords,status,is_default,version,created_at,updated_at,payload)
select id,short_id,name,normalized_name,keywords,'enabled',true,1,now(),now(),
  jsonb_build_object(
    'id',id,'shortId',short_id,'name',name,'keywords',keywords,'status','enabled',
    'isDefault',true,'version',1,
    'createdAt',to_jsonb(to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'updatedAt',to_jsonb(to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  )
from defaults on conflict(normalized_name) do nothing;

insert into content_machine.editorial_interest_events(interest_id,action,payload)
select id,'seeded',jsonb_build_object('interestId',id,'version',1,'status','enabled')
from content_machine.editorial_interests where is_default=true
on conflict do nothing;

revoke all on content_machine.discovery_schedule_state from public;
revoke all on content_machine.editorial_interests from public;
revoke all on content_machine.editorial_interest_events from public;
