update content_machine.editorial_interests
set payload=jsonb_set(
  jsonb_set(
    payload,
    '{createdAt}',
    to_jsonb(to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ),
  '{updatedAt}',
  to_jsonb(to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
where payload->>'createdAt' !~ 'T' or payload->>'updatedAt' !~ 'T';

update content_machine.automation_jobs
set status='queued',attempt=0,available_at=now(),lease_owner=null,lease_expires_at=null,
    failure_code=null,failure_summary=null,diagnostic_id=null,completed_at=null,
    updated_at=now(),version=version+1
where job_type='discovery' and status='failed'
  and failure_summary like '%Invalid ISO datetime%';
