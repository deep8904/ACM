update content_machine.topic_queue_items
set payload=jsonb_set(
  payload,
  '{updatedAt}',
  to_jsonb(to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
where coalesce(payload->>'updatedAt','') !~ 'T';
