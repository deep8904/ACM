import { createHash } from "node:crypto";

import { type DatabaseClient, withTransaction } from "../database/client";
import { toJsonValue } from "../database/json";
import {
  automationJobSchema,
  systemHeartbeatSchema,
  type AutomationJob,
  type AutomationJobStatus,
  type EnqueueAutomationJob,
  type SystemHeartbeat,
} from "./models";

type JobRow = {
  id: string;
  idempotency_key: string;
  job_type: AutomationJob["type"];
  status: AutomationJobStatus;
  topic_id: string | null;
  parent_job_id: string | null;
  lineage_key: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempt: number;
  maximum_attempts: number;
  available_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  failure_code: string | null;
  failure_summary: string | null;
  diagnostic_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  version: number;
};

export class PostgresAutomationJobRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async enqueue(input: EnqueueAutomationJob): Promise<AutomationJob> {
    const idempotencyKey = assertHash(input.idempotencyKey);
    const id = `automationjob_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`;
    const rows = await this.sql<JobRow[]>`
      insert into content_machine.automation_jobs
        (id,idempotency_key,job_type,status,topic_id,parent_job_id,lineage_key,payload,maximum_attempts,available_at)
      values (${id},${idempotencyKey},${input.type},'queued',${input.topicId ?? null},${input.parentJobId ?? null},${input.lineageKey},${this.sql.json(toJsonValue(input.payload ?? {}))},${input.maximumAttempts ?? 3},${input.availableAt ?? new Date().toISOString()})
      on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key
      returning *
    `;
    return fromRow(required(rows[0], "Failed to enqueue automation job"));
  }

  async claim(
    workerId: string,
    leaseMs: number,
  ): Promise<AutomationJob | undefined> {
    const rows = await this.sql<JobRow[]>`
      with candidate as (
        select id from content_machine.automation_jobs
        where available_at <= now()
          and (
            status in ('queued','retryable')
            or (status='running' and lease_expires_at < now())
          )
          and attempt < maximum_attempts
        order by available_at, created_at, id
        for update skip locked
        limit 1
      )
      update content_machine.automation_jobs j
      set status='running', lease_owner=${workerId},
          lease_expires_at=now() + (${leaseMs} * interval '1 millisecond'),
          heartbeat_at=now(), started_at=coalesce(started_at,now()),
          attempt=attempt+1, updated_at=now(), version=version+1
      from candidate where j.id=candidate.id returning j.*
    `;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async heartbeat(
    id: string,
    workerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update content_machine.automation_jobs
      set heartbeat_at=now(),lease_expires_at=now()+(${leaseMs} * interval '1 millisecond'),updated_at=now(),version=version+1
      where id=${id} and status='running' and lease_owner=${workerId}
      returning id
    `;
    return Boolean(rows[0]);
  }

  async succeed(
    id: string,
    workerId: string,
    result: Record<string, unknown> = {},
  ): Promise<void> {
    await withTransaction(this.sql, async (tx) => {
      const rows = await tx<
        { id: string; job_type: string; payload: Record<string, unknown> }[]
      >`
        update content_machine.automation_jobs
        set status='succeeded',result=${tx.json(toJsonValue(result))},lease_owner=null,lease_expires_at=null,
            heartbeat_at=now(),completed_at=now(),updated_at=now(),failure_code=null,
            failure_summary=null,diagnostic_id=null,version=version+1
        where id=${id} and status='running' and lease_owner=${workerId}
        returning id,job_type,payload
      `;
      const row = rows[0];
      if (!row)
        throw new Error("Automation job lease was lost before completion");
      if (
        row.job_type === "discovery" &&
        typeof row.payload.windowStart === "string" &&
        typeof row.payload.windowEnd === "string" &&
        typeof row.payload.runId === "string"
      )
        await tx`
          update content_machine.discovery_schedule_state
          set last_successful_at=now(),last_window_start=${row.payload.windowStart},
              last_window_end=${row.payload.windowEnd},last_run_id=${row.payload.runId},updated_at=now()
          where id='primary' and (last_window_end is null or last_window_end < ${row.payload.windowEnd})
        `;
    });
  }

  async fail(
    id: string,
    workerId: string,
    input: {
      code: string;
      summary: string;
      retryable: boolean;
      blocked?: boolean;
    },
  ): Promise<AutomationJob> {
    const diagnosticId = `diag_${createHash("sha256").update(`${id}:${Date.now()}:${input.code}`).digest("hex").slice(0, 16)}`;
    const rows = await this.sql<JobRow[]>`
      update content_machine.automation_jobs
      set status=case
            when ${Boolean(input.blocked)} then 'blocked'
            when ${input.retryable} and attempt < maximum_attempts then 'retryable'
            else 'failed'
          end,
          available_at=case when ${input.retryable} then now() + (least(60, power(2,attempt)::int) * interval '1 minute') else available_at end,
          failure_code=${input.code.slice(0, 100)},failure_summary=${input.summary.slice(0, 1000)},diagnostic_id=${diagnosticId},
          lease_owner=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now(),
          completed_at=case when ${input.retryable} and attempt < maximum_attempts and not ${Boolean(input.blocked)} then null else now() end,
          version=version+1
      where id=${id} and status='running' and lease_owner=${workerId} returning *
    `;
    return fromRow(
      required(
        rows[0],
        "Automation job lease was lost before failure recording",
      ),
    );
  }

  async retry(id: string): Promise<AutomationJob> {
    const rows = await this.sql<JobRow[]>`
      update content_machine.automation_jobs
      set status='queued',available_at=now(),attempt=0,lease_owner=null,lease_expires_at=null,
          failure_code=null,failure_summary=null,diagnostic_id=null,completed_at=null,updated_at=now(),version=version+1
      where id=${id} and status in ('failed','blocked','retryable') returning *
    `;
    return fromRow(required(rows[0], "Job is not eligible for retry"));
  }

  async cancel(id: string): Promise<AutomationJob> {
    const rows = await this.sql<JobRow[]>`
      update content_machine.automation_jobs
      set status='cancelled',lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now(),version=version+1
      where id=${id} and status in ('queued','retryable','blocked','failed') returning *
    `;
    return fromRow(required(rows[0], "Job cannot be safely cancelled"));
  }

  async get(id: string): Promise<AutomationJob | undefined> {
    const rows = await this.sql<
      JobRow[]
    >`select * from content_machine.automation_jobs where id=${id}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async list(
    statuses?: AutomationJobStatus[],
    limit = 20,
  ): Promise<AutomationJob[]> {
    const rows = statuses?.length
      ? await this.sql<
          JobRow[]
        >`select * from content_machine.automation_jobs where status in ${this.sql(statuses)} order by created_at desc limit ${limit}`
      : await this.sql<
          JobRow[]
        >`select * from content_machine.automation_jobs order by created_at desc limit ${limit}`;
    return rows.map(fromRow);
  }

  async heartbeatComponent(value: SystemHeartbeat): Promise<void> {
    const heartbeat = systemHeartbeatSchema.parse(value);
    await this.sql`
      insert into content_machine.automation_heartbeats(component,instance_id,status,details,observed_at)
      values (${heartbeat.component},${heartbeat.instanceId},${heartbeat.status},${this.sql.json(toJsonValue(heartbeat.details))},${heartbeat.observedAt})
      on conflict(component) do update set instance_id=excluded.instance_id,status=excluded.status,
        details=excluded.details,observed_at=excluded.observed_at,updated_at=now()
    `;
  }

  async heartbeats(): Promise<SystemHeartbeat[]> {
    const rows = await this.sql<
      {
        component: SystemHeartbeat["component"];
        instance_id: string;
        status: SystemHeartbeat["status"];
        details: Record<string, unknown>;
        observed_at: Date | string;
      }[]
    >`
      select component,instance_id,status,details,observed_at from content_machine.automation_heartbeats order by component
    `;
    return rows.map((row) =>
      systemHeartbeatSchema.parse({
        component: row.component,
        instanceId: row.instance_id,
        status: row.status,
        details: row.details,
        observedAt: date(row.observed_at),
      }),
    );
  }
}

function fromRow(row: JobRow): AutomationJob {
  return automationJobSchema.parse({
    id: row.id,
    idempotencyKey: row.idempotency_key,
    type: row.job_type,
    status: row.status,
    topicId: row.topic_id ?? undefined,
    parentJobId: row.parent_job_id ?? undefined,
    lineageKey: row.lineage_key,
    payload: row.payload,
    result: row.result ?? undefined,
    attempt: row.attempt,
    maximumAttempts: row.maximum_attempts,
    availableAt: date(row.available_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at
      ? date(row.lease_expires_at)
      : undefined,
    heartbeatAt: row.heartbeat_at ? date(row.heartbeat_at) : undefined,
    failureCode: row.failure_code ?? undefined,
    failureSummary: row.failure_summary ?? undefined,
    diagnosticId: row.diagnostic_id ?? undefined,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    startedAt: row.started_at ? date(row.started_at) : undefined,
    completedAt: row.completed_at ? date(row.completed_at) : undefined,
    version: row.version,
  });
}

function date(value: Date | string): string {
  return new Date(value).toISOString();
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function assertHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("Idempotency key must be a SHA-256 hash");
  return value;
}
