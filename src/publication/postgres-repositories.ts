import type { DatabaseClient } from "../database/client";
import { withTransaction } from "../database/client";
import { stableId } from "../database/hash";
import {
  articleFinalApprovedEventSchema,
  type ArticleFinalApprovedEvent,
} from "../review/models";
import type {
  DeploymentStatusRepository,
  FinalApprovedEventConsumerRepository,
  FinalApprovedEventSource,
  PublicationJobRepository,
  PublicationRepository,
  PublicationVerificationRepository,
  PublicationRepublishRepository,
  ProductionPublicationArtifactRepository,
} from "./interfaces";
import {
  consumptionRecordSchema,
  deploymentRecordSchema,
  publicationJobSchema,
  publicationRecordSchema,
  publicationVerificationSchema,
  publicationRepublishRecordSchema,
  productionPublicationArtifactSchema,
  type ConsumptionRecord,
  type DeploymentRecord,
  type PublicationJob,
  type PublicationRecord,
  type PublicationVerification,
  type PublicationRepublishRecord,
  type ProductionPublicationArtifact,
} from "./models";

type PayloadRow = { payload: unknown };

export class PostgresPublicationJobRepository implements PublicationJobRepository {
  constructor(private sql: DatabaseClient) {}
  async get(eventId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.publication_jobs where event_id=${eventId}`;
    return rows[0] ? publicationJobSchema.parse(rows[0].payload) : undefined;
  }
  async claim(
    event: ArticleFinalApprovedEvent,
    workerId: string,
    now: string,
    staleAfterMs: number,
  ) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<
        PayloadRow[]
      >`select payload from content_machine.publication_jobs where event_id=${event.id} for update`;
      const old = rows[0]
        ? publicationJobSchema.parse(rows[0].payload)
        : undefined;
      if (
        old &&
        !["failed", "blocked"].includes(old.status) &&
        Date.parse(now) - Date.parse(old.heartbeatAt) <= staleAfterMs
      )
        return old;
      const value = publicationJobSchema.parse({
        id: stableId("publicationjob", event.id),
        finalApprovedEventId: event.id,
        topicId: event.topicId,
        draftId: event.draftId,
        draftVersion: event.draftVersion,
        reviewId: event.reviewId,
        reviewVersion: event.reviewVersion,
        attempt: (old?.attempt ?? 0) + 1,
        status: "claimed",
        startedAt: old?.startedAt ?? now,
        heartbeatAt: now,
        workerId,
        version: (old?.version ?? 0) + 1,
      });
      const lease = new Date(Date.parse(now) + staleAfterMs).toISOString();
      await tx`
        insert into content_machine.publication_jobs
          (id,event_id,topic_id,status,worker_id,claimed_at,heartbeat_at,lease_expires_at,attempt_count,version,payload,updated_at)
        values (${value.id},${event.id},${event.topicId},${value.status},${workerId},${now},${now},${lease},${value.attempt},${value.version},${tx.json(value)},now())
        on conflict(event_id) do update set status=excluded.status,worker_id=excluded.worker_id,claimed_at=excluded.claimed_at,
          heartbeat_at=excluded.heartbeat_at,lease_expires_at=excluded.lease_expires_at,attempt_count=excluded.attempt_count,
          version=excluded.version,payload=excluded.payload,updated_at=now()
      `;
      return value;
    });
  }
  async save(job: PublicationJob) {
    const value = publicationJobSchema.parse(job);
    await this.sql`
      insert into content_machine.publication_jobs(id,event_id,topic_id,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload)
      values (${value.id},${value.finalApprovedEventId},${value.topicId},${value.status},${value.workerId},${value.startedAt},${value.heartbeatAt},${value.attempt},${value.version},${this.sql.json(value)})
      on conflict(event_id) do update set status=excluded.status,worker_id=excluded.worker_id,heartbeat_at=excluded.heartbeat_at,
        attempt_count=excluded.attempt_count,version=excluded.version,payload=excluded.payload,updated_at=now()
    `;
  }
}

export class PostgresPublicationRepository implements PublicationRepository {
  constructor(private sql: DatabaseClient) {}
  async getByEvent(eventId: string) {
    return this.one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.publications where event_id=${eventId}`,
    );
  }
  async getByTopic(topicId: string) {
    return this.one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.publications where topic_id=${topicId}`,
    );
  }
  async save(record: PublicationRecord) {
    const value = publicationRecordSchema.parse(record);
    const rows = await this.sql<{ id: string }[]>`
      insert into content_machine.publications
        (id,event_id,topic_id,commit_sha,canonical_url,content_hash,idempotency_key,payload,published_at)
      values (${value.id},${value.finalApprovedEventId},${value.topicId},${value.commitSha},${value.canonicalUrl},${value.contentHash},${value.finalApprovedEventId},${this.sql.json(value)},${value.publishedAt})
      on conflict(id) do update set commit_sha=excluded.commit_sha,canonical_url=excluded.canonical_url,
        content_hash=excluded.content_hash,payload=excluded.payload,published_at=excluded.published_at
        where (content_machine.publications.payload->>'version')::int < ${value.version}
      returning id
    `;
    if (!rows[0]) {
      const current = await this.getByEvent(value.finalApprovedEventId);
      if (JSON.stringify(current) !== JSON.stringify(value))
        throw new Error("Publication version conflict");
    }
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.publications order by published_at,id`;
    return rows.map((row) => publicationRecordSchema.parse(row.payload));
  }
  private one(rows: PayloadRow[]) {
    return rows[0] ? publicationRecordSchema.parse(rows[0].payload) : undefined;
  }
}

export class PostgresPublicationRepublishRepository implements PublicationRepublishRepository {
  constructor(private sql: DatabaseClient) {}
  async getByIdempotencyKey(idempotencyKey: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.publication_republishes
      where idempotency_key=${idempotencyKey}
    `;
    return rows[0]
      ? publicationRepublishRecordSchema.parse(rows[0].payload)
      : undefined;
  }
  async getById(id: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.publication_republishes where id=${id}
    `;
    return rows[0]
      ? publicationRepublishRecordSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(record: PublicationRepublishRecord) {
    const value = publicationRepublishRecordSchema.parse(record);
    const rows = await this.sql<{ id: string }[]>`
      insert into content_machine.publication_republishes
        (id,source_publication_id,event_id,repository,base_branch,branch,content_hash,idempotency_key,payload,created_at)
      values (${value.id},${value.sourcePublicationId},${value.sourceFinalApprovedEventId},${value.repository},${value.baseBranch},${value.branch},${value.targetContentHash},${value.idempotencyKey},${this.sql.json(value)},${value.createdAt})
      on conflict(idempotency_key) do nothing
      returning id
    `;
    if (!rows[0]) {
      const old = await this.getByIdempotencyKey(value.idempotencyKey);
      if (JSON.stringify(old) !== JSON.stringify(value))
        throw new Error("Republish record is immutable");
    }
  }
  async list() {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.publication_republishes order by created_at,id
    `;
    return rows.map((row) =>
      publicationRepublishRecordSchema.parse(row.payload),
    );
  }
}

export class PostgresProductionPublicationArtifactRepository implements ProductionPublicationArtifactRepository {
  constructor(private sql: DatabaseClient) {}
  async getById(id: string) {
    return this.one(
      await this.sql<PayloadRow[]>`
      select payload from content_machine.production_publication_artifacts where id=${id}
    `,
    );
  }
  async getByRepublishId(republishId: string) {
    return this.one(
      await this.sql<PayloadRow[]>`
      select payload from content_machine.production_publication_artifacts where republish_id=${republishId}
    `,
    );
  }
  async save(record: ProductionPublicationArtifact) {
    const value = productionPublicationArtifactSchema.parse(record);
    const rows = await this.sql<{ id: string }[]>`
      insert into content_machine.production_publication_artifacts
        (id,republish_id,source_publication_id,event_id,repository,production_commit_sha,canonical_url,content_hash,deployment_provider,deployment_status,idempotency_key,payload,verified_at)
      values (${value.id},${value.republishId},${value.sourcePublicationId},${value.finalApprovedEventId},${value.repository},${value.productionCommitSha},${value.canonicalUrl},${value.contentHash},${value.deploymentProvider},${value.deploymentStatus},${value.idempotencyKey},${this.sql.json(value)},${value.verifiedAt})
      on conflict(republish_id) do nothing returning id
    `;
    if (!rows[0]) {
      const old = await this.getByRepublishId(value.republishId);
      if (JSON.stringify(old) !== JSON.stringify(value))
        throw new Error("Production publication artifact is immutable");
    }
  }
  async list() {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.production_publication_artifacts order by verified_at,id
    `;
    return rows.map((row) =>
      productionPublicationArtifactSchema.parse(row.payload),
    );
  }
  private one(rows: PayloadRow[]) {
    return rows[0]
      ? productionPublicationArtifactSchema.parse(rows[0].payload)
      : undefined;
  }
}

export class PostgresEventConsumerRepository implements FinalApprovedEventConsumerRepository {
  constructor(private sql: DatabaseClient) {}
  async get(eventId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.publication_consumptions where event_id=${eventId}`;
    return rows[0] ? consumptionRecordSchema.parse(rows[0].payload) : undefined;
  }
  async consume(record: ConsumptionRecord) {
    const value = consumptionRecordSchema.parse(record);
    const rows = await this.sql<{ event_id: string }[]>`
      insert into content_machine.publication_consumptions(event_id,publication_id,success_condition,consumed_at,payload)
      values (${value.finalApprovedEventId},${value.publicationId},${value.verificationState},${value.consumedAt},${this.sql.json(value)})
      on conflict do nothing returning event_id
    `;
    return Boolean(rows[0]);
  }
}

export class PostgresDeploymentStatusRepository implements DeploymentStatusRepository {
  constructor(private sql: DatabaseClient) {}
  async get(publicationId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.deployment_records where publication_id=${publicationId}`;
    return rows[0] ? deploymentRecordSchema.parse(rows[0].payload) : undefined;
  }
  async save(record: DeploymentRecord) {
    const value = deploymentRecordSchema.parse(record);
    await this.sql`
      insert into content_machine.deployment_records(publication_id,commit_sha,status,version,payload,updated_at)
      values (${value.publicationId},${value.commitSha},${value.status},${value.version},${this.sql.json(value)},${value.checkedAt})
      on conflict(publication_id) do update set commit_sha=excluded.commit_sha,status=excluded.status,
        version=excluded.version,payload=excluded.payload,updated_at=excluded.updated_at
    `;
  }
}

export class PostgresPublicationVerificationRepository implements PublicationVerificationRepository {
  constructor(private sql: DatabaseClient) {}
  async get(publicationId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.publication_verifications where publication_id=${publicationId}`;
    return rows[0]
      ? publicationVerificationSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(record: PublicationVerification) {
    const value = publicationVerificationSchema.parse(record);
    await this.sql`
      insert into content_machine.publication_verifications(publication_id,canonical_url,verified,payload,updated_at)
      select ${value.publicationId},p.canonical_url,${value.status === "verified"},${this.sql.json(value)},${value.verifiedAt}
      from content_machine.publications p where p.id=${value.publicationId}
      on conflict(publication_id) do update set verified=excluded.verified,payload=excluded.payload,updated_at=excluded.updated_at,
        version=content_machine.publication_verifications.version+1
    `;
  }
}

export class PostgresFinalApprovedEventSource implements FinalApprovedEventSource {
  constructor(private sql: DatabaseClient) {}
  async getById(eventId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.final_approved_events where id=${eventId}`;
    return rows[0]
      ? articleFinalApprovedEventSchema.parse(rows[0].payload)
      : undefined;
  }
  async due(now: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.final_approved_events where status='scheduled' and scheduled_for<=${now} order by scheduled_for,id`;
    return rows.map((row) =>
      articleFinalApprovedEventSchema.parse(row.payload),
    );
  }
  async next(now: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.final_approved_events
      where status='ready_for_publication' or (status='scheduled' and scheduled_for<=${now})
      order by created_at,id limit 1
    `;
    return rows[0]
      ? articleFinalApprovedEventSchema.parse(rows[0].payload)
      : undefined;
  }
}
