import type { DatabaseClient } from "../database/client";
import { withTransaction } from "../database/client";
import { sha256, stableId } from "../database/hash";
import { toJsonValue } from "../database/json";
import { researchPacketSchema } from "../research/models";
import { draftQualityReportSchema, type ArticleDraft } from "../writing/models";
import type {
  DraftPreviewRepository,
  EditorialIssueRepository,
  EditorialReviewJobRepository,
  EditorialReviewRepository,
  FinalApprovalRepository,
  FinalApprovedEventRepository,
  FinalConversationRepository,
  ReviewGateRepository,
  ReviewTaskRepository,
  RevisionTaskRepository,
} from "./interfaces";
import {
  articleFinalApprovedEventSchema,
  draftPreviewSchema,
  editorialIssueSchema,
  editorialReviewJobSchema,
  editorialReviewResultSchema,
  finalApprovalRecordSchema,
  finalConversationStateSchema,
  revisionRequestSchema,
  type ArticleFinalApprovedEvent,
  type DeterministicEditorialReport,
  type DraftPreview,
  type EditorialReviewJob,
  type EditorialReviewResult,
  type FinalApprovalRecord,
  type FinalConversationState,
  type RevisionRequest,
} from "./models";

type PayloadRow = { payload: unknown };

export class PostgresEditorialReviewJobRepository implements EditorialReviewJobRepository {
  constructor(private sql: DatabaseClient) {}
  async claim(draft: ArticleDraft, workerId: string, now: string) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<
        PayloadRow[]
      >`select payload from content_machine.editorial_review_jobs where topic_id=${draft.topicId} and draft_version=${draft.version} for update`;
      const old = rows[0]
        ? editorialReviewJobSchema.parse(rows[0].payload)
        : undefined;
      if (old && !["failed", "blocked", "cancelled"].includes(old.status))
        return old;
      const value = editorialReviewJobSchema.parse({
        id: stableId("reviewjob", `${draft.topicId}:${draft.version}`),
        topicId: draft.topicId,
        draftId: draft.id,
        draftVersion: draft.version,
        researchPacketId: draft.researchPacketId,
        researchPacketVersion: draft.researchPacketVersion,
        attempt: (old?.attempt ?? 0) + 1,
        status: "claimed",
        startedAt: old?.startedAt ?? now,
        heartbeatAt: now,
        workerId,
        version: (old?.version ?? 0) + 1,
      });
      await tx`
        insert into content_machine.editorial_review_jobs
          (id,topic_id,draft_version,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload,updated_at)
        values (${value.id},${value.topicId},${value.draftVersion},${value.status},${workerId},${now},${now},${value.attempt},${value.version},${tx.json(value)},now())
        on conflict(topic_id,draft_version) do update set status=excluded.status,worker_id=excluded.worker_id,
          claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,attempt_count=excluded.attempt_count,
          version=excluded.version,payload=excluded.payload,updated_at=now()
      `;
      return value;
    });
  }
  async get(topicId: string, draftVersion: number) {
    return this.one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.editorial_review_jobs where topic_id=${topicId} and draft_version=${draftVersion}`,
    );
  }
  async getById(id: string) {
    return this.one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.editorial_review_jobs where id=${id}`,
    );
  }
  async save(job: EditorialReviewJob) {
    const value = editorialReviewJobSchema.parse(job);
    await this.sql`
      insert into content_machine.editorial_review_jobs(id,topic_id,draft_version,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload)
      values (${value.id},${value.topicId},${value.draftVersion},${value.status},${value.workerId},${value.startedAt},${value.heartbeatAt},${value.attempt},${value.version},${this.sql.json(value)})
      on conflict(topic_id,draft_version) do update set status=excluded.status,worker_id=excluded.worker_id,heartbeat_at=excluded.heartbeat_at,
        attempt_count=excluded.attempt_count,version=excluded.version,payload=excluded.payload,updated_at=now()
    `;
  }
  private one(rows: PayloadRow[]) {
    return rows[0]
      ? editorialReviewJobSchema.parse(rows[0].payload)
      : undefined;
  }
}

export class PostgresEditorialReviewRepository
  implements EditorialReviewRepository, EditorialIssueRepository
{
  constructor(private sql: DatabaseClient) {}
  async nextVersion(topicId: string, draftVersion: number) {
    const rows = await this.sql<
      { version: number }[]
    >`select coalesce(max(review_version),0)::int+1 as version from content_machine.editorial_reviews where topic_id=${topicId} and draft_version=${draftVersion}`;
    return rows[0]?.version ?? 1;
  }
  async get(topicId: string, draftVersion: number, reviewVersion?: number) {
    const rows = reviewVersion
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.editorial_reviews where topic_id=${topicId} and draft_version=${draftVersion} and review_version=${reviewVersion}`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.editorial_reviews where topic_id=${topicId} and draft_version=${draftVersion} order by review_version desc limit 1`;
    return rows[0]
      ? editorialReviewResultSchema.parse(rows[0].payload)
      : undefined;
  }
  async findByImportHash(hash: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.editorial_reviews where import_hash=${hash}`;
    return rows[0]
      ? editorialReviewResultSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(
    review: EditorialReviewResult,
    deterministic: DeterministicEditorialReport,
    provenance: unknown,
  ) {
    const value = editorialReviewResultSchema.parse(review);
    await withTransaction(this.sql, async (tx) => {
      await tx`
        insert into content_machine.editorial_reviews
          (id,topic_id,draft_version,review_version,import_hash,payload,deterministic_report,provenance)
        values (${value.id},${value.topicId},${value.draftVersion},${value.version},${value.provenance.importHash},${tx.json(value)},${tx.json(deterministic)},${tx.json(toJsonValue(provenance))})
      `;
      for (const issue of value.issues) {
        await tx`
          insert into content_machine.editorial_issues
            (id,review_id,topic_id,draft_version,review_version,severity,resolved_at,revised_draft_version,payload)
          values (${issue.id},${value.id},${value.topicId},${value.draftVersion},${value.version},${issue.severity},${issue.resolvedAt ?? null},null,${tx.json(issue)})
        `;
      }
    });
  }
  async resolveIssues(
    topicId: string,
    draftVersion: number,
    issueIds: string[],
    revisedDraftVersion: number,
    resolvedAt: string,
  ) {
    await withTransaction(this.sql, async (tx) => {
      for (const id of issueIds) {
        const rows = await tx<
          PayloadRow[]
        >`select payload from content_machine.editorial_issues where id=${id} and topic_id=${topicId} and draft_version=${draftVersion} for update`;
        if (!rows[0]) throw new Error(`Editorial issue not found: ${id}`);
        const issue = editorialIssueSchema.parse(rows[0].payload);
        const resolved = editorialIssueSchema.parse({
          ...issue,
          status: "resolved",
          resolvedAt,
          resolutionNotes: `Resolved by draft v${revisedDraftVersion}`,
        });
        await tx`update content_machine.editorial_issues set resolved_at=${resolvedAt},revised_draft_version=${revisedDraftVersion},payload=${tx.json(resolved)} where id=${id}`;
      }
    });
  }
  async list(topicId: string, draftVersion: number, reviewVersion?: number) {
    const version =
      reviewVersion ?? (await this.get(topicId, draftVersion))?.version;
    if (!version) return [];
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.editorial_issues where topic_id=${topicId} and draft_version=${draftVersion} and review_version=${version} order by id`;
    return rows.map((row) => editorialIssueSchema.parse(row.payload));
  }
}

export class PostgresEditorialIssueRepository implements EditorialIssueRepository {
  constructor(private reviews: PostgresEditorialReviewRepository) {}
  list(topicId: string, draftVersion: number, reviewVersion?: number) {
    return this.reviews.list(topicId, draftVersion, reviewVersion);
  }
}

class PostgresTaskBase {
  constructor(
    protected sql: DatabaseClient,
    private table: "review_tasks" | "revision_tasks",
  ) {}
  protected async writeFiles(
    topicId: string,
    draftVersion: number,
    files: Record<string, string>,
    inputName: string,
  ) {
    const input = files[inputName]
      ? (JSON.parse(files[inputName]) as unknown)
      : null;
    if (this.table === "review_tasks") {
      await this
        .sql`insert into content_machine.review_tasks(topic_id,draft_version,input_payload,files) values (${topicId},${draftVersion},${input ? this.sql.json(toJsonValue(input)) : null},${this.sql.json(toJsonValue(files))}) on conflict(topic_id,draft_version) do update set input_payload=excluded.input_payload,files=excluded.files`;
    } else {
      await this
        .sql`insert into content_machine.revision_tasks(topic_id,draft_version,input_payload,files) values (${topicId},${draftVersion},${input ? this.sql.json(toJsonValue(input)) : null},${this.sql.json(toJsonValue(files))}) on conflict(topic_id,draft_version) do update set input_payload=excluded.input_payload,files=excluded.files,updated_at=now()`;
    }
    return `postgres://content_machine/${this.table}/${topicId}/v${draftVersion}`;
  }
  protected async read(topicId: string, draftVersion: number) {
    const rows =
      this.table === "review_tasks"
        ? await this.sql<
            { input_payload: unknown }[]
          >`select input_payload from content_machine.review_tasks where topic_id=${topicId} and draft_version=${draftVersion}`
        : await this.sql<
            { input_payload: unknown }[]
          >`select input_payload from content_machine.revision_tasks where topic_id=${topicId} and draft_version=${draftVersion}`;
    return rows[0]?.input_payload ?? undefined;
  }
}

export class PostgresReviewTaskRepository
  extends PostgresTaskBase
  implements ReviewTaskRepository
{
  constructor(sql: DatabaseClient) {
    super(sql, "review_tasks");
  }
  write(topicId: string, draftVersion: number, files: Record<string, string>) {
    return this.writeFiles(topicId, draftVersion, files, "review-input.json");
  }
  readInput(topicId: string, draftVersion: number) {
    return this.read(topicId, draftVersion);
  }
}

export class PostgresRevisionTaskRepository
  extends PostgresTaskBase
  implements RevisionTaskRepository
{
  constructor(sql: DatabaseClient) {
    super(sql, "revision_tasks");
  }
  write(topicId: string, draftVersion: number, files: Record<string, string>) {
    return this.writeFiles(topicId, draftVersion, files, "revision-input.json");
  }
  readInput(topicId: string, draftVersion: number) {
    return this.read(topicId, draftVersion);
  }
  async saveRequest(request: RevisionRequest) {
    const value = revisionRequestSchema.parse(request);
    await this
      .sql`insert into content_machine.revision_tasks(topic_id,draft_version,files,request_payload) values (${value.topicId},${value.draftVersion},${this.sql.json({})},${this.sql.json(value)}) on conflict(topic_id,draft_version) do update set request_payload=excluded.request_payload,updated_at=now()`;
  }
  async getRequest(topicId: string, draftVersion: number) {
    const rows = await this.sql<
      { request_payload: unknown }[]
    >`select request_payload from content_machine.revision_tasks where topic_id=${topicId} and draft_version=${draftVersion}`;
    return rows[0]?.request_payload
      ? revisionRequestSchema.parse(rows[0].request_payload)
      : undefined;
  }
  async saveResolution(
    topicId: string,
    draftVersion: number,
    issueIds: string[],
    revisedDraftVersion: number,
    resolvedAt: string,
  ) {
    await this
      .sql`update content_machine.revision_tasks set resolution_payload=${this.sql.json({ issueIds, revisedDraftVersion, resolvedAt })},updated_at=now() where topic_id=${topicId} and draft_version=${draftVersion}`;
  }
}

export class PostgresFinalApprovalRepository implements FinalApprovalRepository {
  constructor(private sql: DatabaseClient) {}
  async get(topicId: string, version?: number) {
    const rows = version
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.final_approvals where topic_id=${topicId} and (payload->>'version')::int=${version}`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.final_approvals where topic_id=${topicId} order by (payload->>'version')::int desc limit 1`;
    return rows[0]
      ? finalApprovalRecordSchema.parse(rows[0].payload)
      : undefined;
  }
  async getByShortId(shortId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.final_approvals where short_id=${shortId}`;
    return rows[0]
      ? finalApprovalRecordSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(record: FinalApprovalRecord) {
    await this.write(this.sql, finalApprovalRecordSchema.parse(record));
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.final_approvals order by created_at,id`;
    return rows.map((row) => finalApprovalRecordSchema.parse(row.payload));
  }
  async saveWithEvent(
    record: FinalApprovalRecord,
    event: ArticleFinalApprovedEvent | undefined,
    expectedEventVersion?: number,
  ) {
    const approval = finalApprovalRecordSchema.parse(record);
    const outbox = event
      ? articleFinalApprovedEventSchema.parse(event)
      : undefined;
    return withTransaction(this.sql, async (tx) => {
      await this.write(tx, approval);
      if (!outbox) return true;
      if (expectedEventVersion === undefined) {
        const rows = await tx<{ id: string }[]>`
          insert into content_machine.final_approved_events
            (id,topic_id,approval_id,draft_version,review_version,status,version,scheduled_for,snapshot_hash,payload)
          values (${outbox.id},${outbox.topicId},${approval.id},${outbox.draftVersion},${outbox.reviewVersion},${outbox.status},${outbox.version},${outbox.requestedPublishAt ?? null},${outbox.articleSnapshotHash},${tx.json(outbox)})
          on conflict do nothing returning id
        `;
        return Boolean(rows[0]);
      }
      const rows = await tx<{ id: string }[]>`
        update content_machine.final_approved_events set status=${outbox.status},version=${outbox.version},
          scheduled_for=${outbox.requestedPublishAt ?? null},payload=${tx.json(outbox)}
        where id=${outbox.id} and version=${expectedEventVersion} returning id
      `;
      return Boolean(rows[0]);
    });
  }
  private async write(
    sql: DatabaseClient | import("../database/client").DatabaseTransaction,
    value: FinalApprovalRecord,
  ) {
    await sql`
      insert into content_machine.final_approvals
        (id,short_id,topic_id,draft_version,review_version,status,content_hash,payload,created_at)
      values (${value.id},${value.shortId},${value.topicId},${value.draftVersion},${value.reviewVersion},${value.status},${sha256(JSON.stringify(value))},${sql.json(value)},${value.createdAt})
      on conflict(id) do update set status=excluded.status,content_hash=excluded.content_hash,payload=excluded.payload
        where (content_machine.final_approvals.payload->>'version')::int < ${value.version}
    `;
  }
}

export class PostgresFinalApprovedEventRepository implements FinalApprovedEventRepository {
  constructor(private sql: DatabaseClient) {}
  async get(topicId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.final_approved_events where topic_id=${topicId}`;
    return rows[0]
      ? articleFinalApprovedEventSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(event: ArticleFinalApprovedEvent) {
    const value = articleFinalApprovedEventSchema.parse(event);
    const rows = await this.sql<{ id: string }[]>`
      insert into content_machine.final_approved_events(id,topic_id,approval_id,draft_version,review_version,status,version,scheduled_for,snapshot_hash,payload)
      select ${value.id},${value.topicId},a.id,${value.draftVersion},${value.reviewVersion},${value.status},${value.version},${value.requestedPublishAt ?? null},${value.articleSnapshotHash},${this.sql.json(value)}
      from content_machine.final_approvals a where a.topic_id=${value.topicId}
      on conflict do nothing returning id
    `;
    return Boolean(rows[0]);
  }
  async update(event: ArticleFinalApprovedEvent, expectedVersion: number) {
    const value = articleFinalApprovedEventSchema.parse(event);
    const rows = await this.sql<
      { id: string }[]
    >`update content_machine.final_approved_events set status=${value.status},version=${value.version},scheduled_for=${value.requestedPublishAt ?? null},payload=${this.sql.json(value)} where id=${value.id} and version=${expectedVersion} returning id`;
    if (!rows[0]) throw new Error("Final-approved event version conflict");
  }
}

export class PostgresDraftPreviewRepository implements DraftPreviewRepository {
  constructor(private sql: DatabaseClient) {}
  async save(preview: DraftPreview, html: string) {
    const location = `postgres://content_machine/draft_previews/${preview.id}`;
    const value = draftPreviewSchema.parse({ ...preview, path: location });
    await this
      .sql`insert into content_machine.draft_previews(id,topic_id,draft_version,html,content_hash,payload,created_at) values (${value.id},${value.topicId},${value.draftVersion},${html},${value.articleHash},${this.sql.json(value)},${value.createdAt}) on conflict(topic_id,draft_version) do update set html=excluded.html,content_hash=excluded.content_hash,payload=excluded.payload`;
    return location;
  }
  async get(topicId: string, draftVersion: number) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.draft_previews where topic_id=${topicId} and draft_version=${draftVersion}`;
    return rows[0] ? draftPreviewSchema.parse(rows[0].payload) : undefined;
  }
  async supersede(topicId: string, draftVersion: number, now: string) {
    const current = await this.get(topicId, draftVersion);
    if (!current) return;
    const value = draftPreviewSchema.parse({
      ...current,
      status: "superseded",
    });
    await this
      .sql`update content_machine.draft_previews set superseded_at=${now},payload=${this.sql.json(value)} where topic_id=${topicId} and draft_version=${draftVersion}`;
  }
}

export class PostgresFinalConversationRepository implements FinalConversationRepository {
  constructor(private sql: DatabaseClient) {}
  async get(chatId: string, userId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.final_conversations where chat_id=${chatId} and user_id=${userId} and expires_at>now()`;
    return rows[0]
      ? finalConversationStateSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(state: FinalConversationState) {
    const value = finalConversationStateSchema.parse(state);
    await this
      .sql`insert into content_machine.final_conversations(chat_id,user_id,state,topic_id,version,expires_at,payload) values (${value.chatId},${value.userId},${value.state},${value.topicId},${value.version},${value.expiresAt},${this.sql.json(value)}) on conflict(chat_id,user_id) do update set state=excluded.state,topic_id=excluded.topic_id,version=excluded.version,expires_at=excluded.expires_at,payload=excluded.payload,updated_at=now()`;
  }
  async clear(chatId: string, userId: string) {
    await this
      .sql`delete from content_machine.final_conversations where chat_id=${chatId} and user_id=${userId}`;
  }
}

export class PostgresReviewGateRepository implements ReviewGateRepository {
  constructor(private sql: DatabaseClient) {}
  async packet(topicId: string, version: number) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.research_packets where topic_id=${topicId} and packet_version=${version}`;
    return rows[0] ? researchPacketSchema.parse(rows[0].payload) : undefined;
  }
  async quality(topicId: string, draftVersion: number) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.draft_quality_reports where topic_id=${topicId} and draft_version=${draftVersion}`;
    return rows[0]
      ? draftQualityReportSchema.parse(rows[0].payload)
      : undefined;
  }
  async topicActive(topicId: string, approvedEventId: string) {
    const rows = await this.sql<{ active: boolean }[]>`
      select exists(select 1 from content_machine.topic_approved_events e join content_machine.topic_queue_items q on q.topic_id=e.topic_id where e.topic_id=${topicId} and e.id=${approvedEventId} and e.status='ready' and q.approval_status='approved') as active
    `;
    return Boolean(rows[0]?.active);
  }
  async topicOrigin(topicId: string) {
    const rows = await this.sql<
      { origin: "ranked" | "manual_topic" | "manual_url" }[]
    >`select payload->>'origin' as origin from content_machine.topic_queue_items where topic_id=${topicId}`;
    return rows[0]?.origin;
  }
}
