import type { DatabaseClient } from "../database/client";
import { withTransaction } from "../database/client";
import { sha256, stableId } from "../database/hash";
import { toJsonValue } from "../database/json";
import {
  topicQueueItemSchema,
  type TopicApprovedEvent,
} from "../telegram/models";
import type {
  AssistedResearchImportRepository,
  ApprovedEventRepository,
  HumanAssistedEvidenceRecord,
  HumanAssistedEvidenceRepository,
  ResearchCacheRepository,
  ResearchJobRepository,
  ResearchPacketRepository,
  ResearchSourceRepository,
  ResearchSourceExtensionRepository,
  ResearchTaskRepository,
} from "./interfaces";
import {
  researchJobSchema,
  researchPacketSchema,
  researchSourceSchema,
  type ResearchJob,
  type ResearchPacket,
  type ResearchSource,
} from "./models";
import { parseDurableApprovedEvent } from "./approved-event";
import {
  parseApprovedResearchLineage,
  type ApprovedResearchLineageRow,
} from "./approved-lineage";
import type { RetrievalDiagnosticCode } from "./retrieve";

type PayloadRow = { payload: unknown };
type ApprovedEventRow = {
  id: string;
  topic_id: string;
  payload: unknown;
};

export class PostgresResearchJobRepository implements ResearchJobRepository {
  constructor(private sql: DatabaseClient) {}
  async claim(
    eventId: string,
    topicId: string,
    workerId: string,
    now: string,
    staleAfterMs: number,
    recoverableStatuses: readonly ResearchJob["status"][] = [
      "failed",
      "cancelled",
    ],
  ) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<
        PayloadRow[]
      >`select payload from content_machine.research_jobs where event_id=${eventId} for update`;
      const old = rows[0]
        ? researchJobSchema.parse(rows[0].payload)
        : undefined;
      if (
        old &&
        !recoverableStatuses.includes(old.status) &&
        Date.parse(now) - Date.parse(old.heartbeatAt) <= staleAfterMs
      )
        return undefined;
      const attempt = (old?.attempt ?? 0) + 1;
      const value = researchJobSchema.parse({
        id: stableId("job", eventId),
        eventId,
        topicId,
        status: "claimed",
        attempt,
        claimedAt: now,
        heartbeatAt: now,
        workerId,
        retries: old
          ? [
              ...old.retries,
              { attempt, at: now, reason: `recovered ${old.status}` },
            ]
          : [],
        errors: old?.errors ?? [],
        version: (old?.version ?? 0) + 1,
      });
      const lease = new Date(Date.parse(now) + staleAfterMs).toISOString();
      await tx`
        insert into content_machine.research_jobs
          (id,event_id,topic_id,status,worker_id,claimed_at,heartbeat_at,lease_expires_at,attempt_count,version,payload,updated_at)
        values (${value.id},${eventId},${topicId},${value.status},${workerId},${now},${now},${lease},${attempt},${value.version},${tx.json(value)},now())
        on conflict (event_id) do update set status=excluded.status,worker_id=excluded.worker_id,claimed_at=excluded.claimed_at,
          heartbeat_at=excluded.heartbeat_at,lease_expires_at=excluded.lease_expires_at,attempt_count=excluded.attempt_count,
          version=excluded.version,payload=excluded.payload,updated_at=now()
      `;
      return value;
    });
  }
  async getByEvent(eventId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.research_jobs where event_id=${eventId}`;
    return rows[0] ? researchJobSchema.parse(rows[0].payload) : undefined;
  }
  async getById(id: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.research_jobs where id=${id}`;
    return rows[0] ? researchJobSchema.parse(rows[0].payload) : undefined;
  }
  async save(job: ResearchJob) {
    const value = researchJobSchema.parse(job);
    await this.sql`
      insert into content_machine.research_jobs(id,event_id,topic_id,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload)
      values (${value.id},${value.eventId},${value.topicId},${value.status},${value.workerId},${value.claimedAt},${value.heartbeatAt},${value.attempt},${value.version},${this.sql.json(value)})
      on conflict(event_id) do update set status=excluded.status,worker_id=excluded.worker_id,heartbeat_at=excluded.heartbeat_at,
        attempt_count=excluded.attempt_count,version=excluded.version,payload=excluded.payload,updated_at=now()
    `;
  }
}

export class PostgresResearchSourceRepository
  implements ResearchSourceRepository, ResearchCacheRepository
{
  constructor(private sql: DatabaseClient) {}
  async save(source: ResearchSource, extractedText: string) {
    const value = researchSourceSchema.parse(source);
    await this.sql`
      insert into content_machine.research_sources
        (id,topic_id,canonical_url,content_hash,extracted_text,byte_length,payload,retrieved_at)
      values (${value.id},${value.topicId},${value.canonicalUrl},${value.contentHash},${extractedText},${Buffer.byteLength(extractedText)},${this.sql.json(toJsonValue(value))},${value.retrievedAt})
      on conflict (topic_id,canonical_url,content_hash) do nothing
    `;
  }
  async list(topicId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.research_sources where topic_id=${topicId} order by content_hash,id`;
    return rows.map((row) => researchSourceSchema.parse(row.payload));
  }
  async get(canonicalUrl: string) {
    const rows = await this.sql<
      { payload: unknown; text_content: string }[]
    >`select payload,text_content from content_machine.research_cache where canonical_url=${canonicalUrl}`;
    return rows[0]
      ? {
          source: researchSourceSchema.parse(rows[0].payload),
          text: rows[0].text_content,
        }
      : undefined;
  }
  async put(source: ResearchSource, text: string) {
    const value = researchSourceSchema.parse(source);
    await this.sql`
      insert into content_machine.research_cache (canonical_url,source_id,content_hash,text_content,payload,fetched_at)
      values (${value.canonicalUrl},${value.id},${value.contentHash},${text},${this.sql.json(toJsonValue(value))},${value.retrievedAt})
      on conflict (canonical_url) do update set source_id=excluded.source_id,content_hash=excluded.content_hash,
        text_content=excluded.text_content,payload=excluded.payload,fetched_at=excluded.fetched_at
    `;
  }
  async getRobots(host: string) {
    const rows = await this.sql<
      { body: string; fetched_at: Date | string }[]
    >`select body,fetched_at from content_machine.robots_cache where host=${host}`;
    return rows[0]
      ? {
          body: rows[0].body,
          fetchedAt: new Date(rows[0].fetched_at).toISOString(),
        }
      : undefined;
  }
  async putRobots(host: string, body: string, fetchedAt: string) {
    await this
      .sql`insert into content_machine.robots_cache(host,body,fetched_at) values (${host},${body},${fetchedAt}) on conflict(host) do update set body=excluded.body,fetched_at=excluded.fetched_at`;
  }
  async claimRetrievalAttempt(input: {
    host: string;
    canonicalUrl: string;
    attemptedAt: string;
    budget: number;
    windowMs: number;
    cooldownMs: number;
  }) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<
        {
          attempt_count: number;
          window_started_at: Date | string;
          cooldown_until: Date | string | null;
        }[]
      >`select attempt_count,window_started_at,cooldown_until
        from content_machine.research_retrieval_host_state
        where host=${input.host} for update`;
      const old = rows[0];
      const at = Date.parse(input.attemptedAt);
      if (old?.cooldown_until && new Date(old.cooldown_until).getTime() > at)
        return {
          allowed: false,
          retryAt: new Date(old.cooldown_until).toISOString(),
        };
      const inWindow = Boolean(
        old && at - new Date(old.window_started_at).getTime() < input.windowMs,
      );
      const attemptCount = inWindow ? (old?.attempt_count ?? 0) + 1 : 1;
      const windowStartedAt = inWindow
        ? new Date(old!.window_started_at).toISOString()
        : input.attemptedAt;
      const retryAt =
        attemptCount > input.budget
          ? new Date(at + input.cooldownMs).toISOString()
          : undefined;
      await tx`
        insert into content_machine.research_retrieval_host_state
          (host,attempt_count,window_started_at,cooldown_until,updated_at)
        values (${input.host},${attemptCount},${windowStartedAt},${retryAt ?? null},now())
        on conflict(host) do update set attempt_count=excluded.attempt_count,
          window_started_at=excluded.window_started_at,
          cooldown_until=excluded.cooldown_until,updated_at=now()
      `;
      return retryAt ? { allowed: false, retryAt } : { allowed: true as const };
    });
  }
  async getRetrievalOutcome(canonicalUrl: string, at: string) {
    const rows = await this.sql<
      {
        diagnostic_code: RetrievalDiagnosticCode;
        retry_at: Date | string | null;
        expires_at: Date | string;
      }[]
    >`select diagnostic_code,retry_at,expires_at
      from content_machine.research_retrieval_outcomes
      where canonical_url=${canonicalUrl} and expires_at>${at}`;
    const value = rows[0];
    return value
      ? {
          code: value.diagnostic_code,
          retryAt: value.retry_at
            ? new Date(value.retry_at).toISOString()
            : undefined,
          expiresAt: new Date(value.expires_at).toISOString(),
        }
      : undefined;
  }
  async putRetrievalOutcome(input: {
    host: string;
    canonicalUrl: string;
    code: RetrievalDiagnosticCode;
    retryAt?: string;
    status: number;
    recordedAt: string;
    expiresAt: string;
  }) {
    await withTransaction(this.sql, async (tx) => {
      await tx`
        insert into content_machine.research_retrieval_outcomes
          (canonical_url,host,diagnostic_code,http_status,retry_at,expires_at,recorded_at)
        values (${input.canonicalUrl},${input.host},${input.code},${input.status},${input.retryAt ?? null},${input.expiresAt},${input.recordedAt})
        on conflict(canonical_url) do update set host=excluded.host,
          diagnostic_code=excluded.diagnostic_code,http_status=excluded.http_status,
          retry_at=excluded.retry_at,expires_at=excluded.expires_at,
          recorded_at=excluded.recorded_at,updated_at=now()
      `;
      if (input.retryAt)
        await tx`
          insert into content_machine.research_retrieval_host_state
            (host,attempt_count,window_started_at,cooldown_until,updated_at)
          values (${input.host},1,${input.recordedAt},${input.retryAt},now())
          on conflict(host) do update set cooldown_until=greatest(
            coalesce(content_machine.research_retrieval_host_state.cooldown_until, excluded.cooldown_until),
            excluded.cooldown_until
          ),updated_at=now()
        `;
    });
  }
  async clearRetrievalOutcome(host: string, canonicalUrl: string) {
    void host;
    await this
      .sql`delete from content_machine.research_retrieval_outcomes where canonical_url=${canonicalUrl}`;
  }
}

export class PostgresResearchTaskRepository implements ResearchTaskRepository {
  constructor(private sql: DatabaseClient) {}
  async write(
    topicId: string,
    packetVersion: number,
    files: Record<string, string>,
    input: unknown,
  ) {
    const id = stableId("researchtask", `${topicId}:${packetVersion}`);
    await this.sql`
      insert into content_machine.research_tasks(id,topic_id,packet_version,input_payload,files)
      values (${id},${topicId},${packetVersion},${this.sql.json(toJsonValue(input))},${this.sql.json(toJsonValue(files))})
      on conflict(id) do update set input_payload=excluded.input_payload,files=excluded.files
    `;
    return `postgres://content_machine/research_tasks/${id}`;
  }
  async readInput(topicId: string, packetVersion: number) {
    const rows = await this.sql<
      { input_payload: unknown }[]
    >`select input_payload from content_machine.research_tasks where topic_id=${topicId} and packet_version=${packetVersion}`;
    return rows[0]?.input_payload ?? undefined;
  }
}

export class PostgresResearchPacketRepository implements ResearchPacketRepository {
  constructor(private sql: DatabaseClient) {}
  async nextVersion(topicId: string) {
    const rows = await this.sql<
      { version: number }[]
    >`select coalesce(max(packet_version),0)::int + 1 as version from content_machine.research_packets where topic_id=${topicId}`;
    return rows[0]?.version ?? 1;
  }
  async save(packet: ResearchPacket) {
    const value = researchPacketSchema.parse(packet);
    await this.sql`
      insert into content_machine.research_packets
        (id,topic_id,approved_event_id,packet_version,import_hash,content_hash,payload)
      values (${value.id},${value.topicId},${value.approvedEventId},${value.version},${value.provenance.importHash ?? null},${sha256(JSON.stringify(value))},${this.sql.json(toJsonValue(value))})
    `;
  }
  async get(topicId: string, version?: number) {
    const rows = version
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.research_packets where topic_id=${topicId} and packet_version=${version}`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.research_packets where topic_id=${topicId} order by packet_version desc limit 1`;
    return rows[0] ? researchPacketSchema.parse(rows[0].payload) : undefined;
  }
  async getByImportHash(topicId: string, importHash: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.research_packets
      where topic_id=${topicId} and import_hash=${importHash}
      limit 1
    `;
    return rows[0] ? researchPacketSchema.parse(rows[0].payload) : undefined;
  }
}

export class PostgresResearchSourceExtensionRepository implements ResearchSourceExtensionRepository {
  constructor(private sql: DatabaseClient) {}
  async persist(
    base: ResearchPacket,
    packet: ResearchPacket,
    source: ResearchSource,
    extractedText: string,
  ) {
    const candidate = researchPacketSchema.parse(packet);
    const extensionHash = candidate.provenance.extensionHash;
    if (!extensionHash) throw new Error("Source extension hash is required");
    return withTransaction(this.sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${base.topicId}, 0))`;
      const latestRows = await tx<PayloadRow[]>`
        select payload from content_machine.research_packets
        where topic_id=${base.topicId}
        order by packet_version desc limit 1
        for update
      `;
      const latest = latestRows[0]
        ? researchPacketSchema.parse(latestRows[0].payload)
        : undefined;
      if (!latest || latest.version !== base.version)
        throw new Error("Research packet advanced during source extension");
      const duplicate = await tx<PayloadRow[]>`
        select payload from content_machine.research_packets
        where topic_id=${base.topicId}
          and payload->'provenance'->>'extensionHash'=${extensionHash}
        limit 1
      `;
      if (duplicate[0]) return researchPacketSchema.parse(duplicate[0].payload);
      const versions = await tx<{ version: number }[]>`
        select coalesce(max(packet_version),0)::int + 1 as version
        from content_machine.research_packets where topic_id=${base.topicId}
      `;
      const value = researchPacketSchema.parse({
        ...candidate,
        version: versions[0]?.version ?? base.version + 1,
      });
      const sourceValue = researchSourceSchema.parse(source);
      await tx`
        insert into content_machine.research_sources
          (id,topic_id,canonical_url,content_hash,extracted_text,byte_length,payload,retrieved_at)
        values (${sourceValue.id},${sourceValue.topicId},${sourceValue.canonicalUrl},${sourceValue.contentHash},${extractedText},${Buffer.byteLength(extractedText)},${tx.json(toJsonValue(sourceValue))},${sourceValue.retrievedAt})
        on conflict (topic_id,canonical_url,content_hash) do nothing
      `;
      await tx`
        insert into content_machine.research_packets
          (id,topic_id,approved_event_id,packet_version,import_hash,content_hash,payload)
        values (${value.id},${value.topicId},${value.approvedEventId},${value.version},null,${sha256(JSON.stringify(value))},${tx.json(toJsonValue(value))})
      `;
      return value;
    });
  }
}

export class PostgresHumanAssistedEvidenceRepository implements HumanAssistedEvidenceRepository {
  constructor(private sql: DatabaseClient) {}

  async persist(
    base: ResearchPacket,
    packet: ResearchPacket,
    source: ResearchSource,
    evidence: HumanAssistedEvidenceRecord,
  ) {
    const candidate = researchPacketSchema.parse(packet);
    const sourceValue = researchSourceSchema.parse(source);
    return withTransaction(this.sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${base.topicId}, 0))`;
      const duplicate = await tx<PayloadRow[]>`
        select p.payload
        from content_machine.research_source_evidence_records e
        join content_machine.research_packets p
          on p.topic_id=e.topic_id and p.packet_version=e.packet_version
        where e.remediation_id=${evidence.remediationId}
          and e.evidence_hash=${evidence.evidenceHash}
        limit 1
      `;
      if (duplicate[0]) return researchPacketSchema.parse(duplicate[0].payload);
      const latestRows = await tx<PayloadRow[]>`
        select payload from content_machine.research_packets
        where topic_id=${base.topicId}
        order by packet_version desc limit 1 for update
      `;
      const latest = latestRows[0]
        ? researchPacketSchema.parse(latestRows[0].payload)
        : undefined;
      if (!latest || latest.version !== base.version)
        throw new Error("Research packet advanced during evidence acceptance");
      const versions = await tx<{ version: number }[]>`
        select coalesce(max(packet_version),0)::int + 1 as version
        from content_machine.research_packets where topic_id=${base.topicId}
      `;
      const version = versions[0]?.version ?? base.version + 1;
      const value = researchPacketSchema.parse({ ...candidate, version });
      const record = { ...evidence, packetVersion: version };
      await tx`
        insert into content_machine.research_sources
          (id,topic_id,canonical_url,content_hash,extracted_text,byte_length,payload,retrieved_at)
        values (${sourceValue.id},${sourceValue.topicId},${sourceValue.canonicalUrl},${sourceValue.contentHash},${record.evidenceText},${Buffer.byteLength(record.evidenceText)},${tx.json(toJsonValue(sourceValue))},${sourceValue.retrievedAt})
        on conflict (topic_id,canonical_url,content_hash) do nothing
      `;
      await tx`
        insert into content_machine.research_packets
          (id,topic_id,approved_event_id,packet_version,import_hash,content_hash,payload)
        values (${value.id},${value.topicId},${value.approvedEventId},${value.version},null,${sha256(JSON.stringify(value))},${tx.json(toJsonValue(value))})
      `;
      await tx`
        insert into content_machine.research_source_evidence_records
          (id,remediation_id,topic_id,event_id,job_id,base_packet_version,packet_version,
           source_id,source_content_hash,canonical_url,publisher_owner,acquisition_mode,operator_actor_hash,evidence_hash,
           evidence_text,provenance_statement,original_diagnostic_id,original_failure_code,
           payload,confirmed_at)
        values (${record.id},${record.remediationId},${record.topicId},${record.eventId},${record.jobId},
          ${record.basePacketVersion},${record.packetVersion},${record.sourceId},${record.sourceContentHash},
          ${record.canonicalUrl},${record.publisherOwner},
          ${record.acquisitionMode},${record.operatorActorHash},${record.evidenceHash},${record.evidenceText},
          ${record.provenanceStatement},${record.originalDiagnosticId},${record.originalFailureCode},
          ${tx.json(toJsonValue(record))},${record.confirmedAt})
      `;
      return value;
    });
  }
}

export class PostgresAssistedResearchImportRepository implements AssistedResearchImportRepository {
  constructor(private sql: DatabaseClient) {}

  async persist(packet: ResearchPacket, importedAt: string) {
    const candidate = researchPacketSchema.parse(packet);
    const importHash = candidate.provenance.importHash;
    if (!importHash) throw new Error("Assisted packet requires an import hash");

    return withTransaction(this.sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${candidate.topicId}, 0))`;
      const duplicate = await tx<PayloadRow[]>`
        select payload from content_machine.research_packets
        where topic_id=${candidate.topicId} and import_hash=${importHash}
        limit 1
      `;
      if (duplicate[0]) {
        const existing = researchPacketSchema.parse(duplicate[0].payload);
        await reconcileEventConsumption(tx, existing, importedAt);
        return existing;
      }

      const versions = await tx<{ version: number }[]>`
        select coalesce(max(packet_version),0)::int + 1 as version
        from content_machine.research_packets
        where topic_id=${candidate.topicId}
      `;
      const value = researchPacketSchema.parse({
        ...candidate,
        version: versions[0]?.version ?? 1,
      });
      await tx`
        insert into content_machine.research_packets
          (id,topic_id,approved_event_id,packet_version,import_hash,content_hash,payload)
        values (${value.id},${value.topicId},${value.approvedEventId},${value.version},${importHash},${sha256(JSON.stringify(value))},${tx.json(toJsonValue(value))})
      `;
      await reconcileEventConsumption(tx, value, importedAt);
      return value;
    });
  }
}

async function reconcileEventConsumption(
  tx: Parameters<Parameters<typeof withTransaction>[1]>[0],
  packet: ResearchPacket,
  importedAt: string,
) {
  const rows = await tx<
    {
      consumed_at: Date | string | null;
      packet_id: string | null;
      packet_version: number | null;
    }[]
  >`
    select consumed_at,packet_id,packet_version
    from content_machine.topic_event_state
    where event_id=${packet.approvedEventId}
    for update
  `;
  const state = rows[0];
  if (!state) throw new Error("Approved event state is missing");
  if (state.consumed_at === null) {
    await tx`
      update content_machine.topic_event_state
      set consumed_at=${importedAt},packet_id=${packet.id},packet_version=${packet.version},
        worker_id=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null,version=version+1
      where event_id=${packet.approvedEventId}
    `;
    return;
  }
  if (state.packet_id !== packet.id)
    throw new Error(
      "Approved event was consumed by a different research packet",
    );
}

export class PostgresApprovedEventRepository implements ApprovedEventRepository {
  constructor(private sql: DatabaseClient) {}
  async next() {
    const rows = await this.sql<ApprovedResearchLineageRow[]>`
      select e.id as event_id,e.topic_id as event_topic_id,e.approval_id as event_approval_id,
        e.payload as event_payload,q.id as queue_id,q.topic_id as queue_topic_id,
        q.candidate_id as queue_candidate_id,q.run_id as queue_run_id,
        q.approval_status as queue_approval_status,q.trigger_state as queue_trigger_state,
        q.payload as queue_payload,a.id as approval_id,a.topic_id as approval_topic_id,
        a.action as approval_action,a.status as approval_status,a.payload as approval_payload
      from content_machine.topic_approved_events e
      join content_machine.topic_event_state s on s.event_id=e.id
      join content_machine.topic_queue_items q on q.topic_id=e.topic_id
      join content_machine.topic_approvals a on a.id=e.approval_id and a.topic_id=e.topic_id
      where s.consumed_at is null and e.status='ready'
        and q.approval_status='approved'
        and q.trigger_state='topic_approved_event_created'
        and q.payload->>'researchReadiness'='ready_for_research'
        and a.action='approve' and a.status='approved'
      order by e.approved_at,e.id limit 1
    `;
    return rows[0] ? parseApprovedResearchLineage(rows[0]).event : undefined;
  }
  async get(id: string) {
    const rows = await this.sql<
      ApprovedEventRow[]
    >`select id,topic_id,payload from content_machine.topic_approved_events where id=${id}`;
    return rows[0]
      ? parseDurableApprovedEvent({
          id: rows[0].id,
          topicId: rows[0].topic_id,
          payload: rows[0].payload,
        })
      : undefined;
  }
  async queue(topicId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.topic_queue_items where topic_id=${topicId}`;
    return rows[0] ? topicQueueItemSchema.parse(rows[0].payload) : undefined;
  }
  async isCancelled(event: TopicApprovedEvent) {
    const queue = await this.queue(event.topicId);
    return (
      event.status === "cancelled" ||
      !queue ||
      queue.approvalStatus !== "approved" ||
      !["ready_for_research", "awaiting_source"].includes(
        queue.researchReadiness,
      )
    );
  }
  async isConsumed(id: string) {
    const rows = await this.sql<
      { consumed: boolean }[]
    >`select consumed_at is not null as consumed from content_machine.topic_event_state where event_id=${id}`;
    return Boolean(rows[0]?.consumed);
  }
  async consume(
    id: string,
    packetId: string,
    packetVersion: number,
    at: string,
  ) {
    const rows = await this.sql<{ event_id: string }[]>`
      update content_machine.topic_event_state set consumed_at=${at},packet_id=${packetId},packet_version=${packetVersion},
        worker_id=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null,version=version+1
      where event_id=${id} and consumed_at is null
        and exists(select 1 from content_machine.research_packets where id=${packetId} and packet_version=${packetVersion})
      returning event_id
    `;
    if (!rows[0])
      throw new Error("Event already consumed or packet is not durable");
  }
}
