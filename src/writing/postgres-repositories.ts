import type { DatabaseClient } from "../database/client";
import { withTransaction } from "../database/client";
import { sha256, stableId } from "../database/hash";
import { toJsonValue } from "../database/json";
import type { ResearchPacket } from "../research/models";
import {
  topicApprovedEventSchema,
  topicQueueItemSchema,
} from "../telegram/models";
import type {
  ArticleDraftRepository,
  ArticleHistoryRepository,
  DraftQualityRepository,
  WritingGateRepository,
  WritingJobRepository,
  WritingTaskRepository,
} from "./interfaces";
import {
  articleDraftSchema,
  articleHistoryEntrySchema,
  draftQualityReportSchema,
  writingJobSchema,
  type ArticleDraft,
  type ArticleHistoryEntry,
  type DraftQualityReport,
  type WritingJob,
} from "./models";

type PayloadRow = { payload: unknown };

export class PostgresWritingJobRepository implements WritingJobRepository {
  constructor(private sql: DatabaseClient) {}
  async claim(
    topicId: string,
    packet: ResearchPacket,
    articleType: WritingJob["articleType"],
    configHash: string,
    workerId: string,
    now: string,
  ) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<
        PayloadRow[]
      >`select payload from content_machine.writing_jobs where topic_id=${topicId} and research_version=${packet.version} for update`;
      const old = rows[0] ? writingJobSchema.parse(rows[0].payload) : undefined;
      if (old && !["failed", "blocked", "cancelled"].includes(old.status))
        return old;
      const value = writingJobSchema.parse({
        id: stableId("writingjob", `${topicId}:${packet.version}`),
        topicId,
        researchPacketId: packet.id,
        researchPacketVersion: packet.version,
        articleType,
        configHash,
        researchContentHashes: packet.contentHashes,
        attempt: (old?.attempt ?? 0) + 1,
        status: "claimed",
        startedAt: old?.startedAt ?? now,
        heartbeatAt: now,
        workerId,
        version: (old?.version ?? 0) + 1,
      });
      await tx`
        insert into content_machine.writing_jobs
          (id,topic_id,research_version,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload,updated_at)
        values (${value.id},${topicId},${packet.version},${value.status},${workerId},${now},${now},${value.attempt},${value.version},${tx.json(value)},now())
        on conflict(topic_id,research_version) do update set status=excluded.status,worker_id=excluded.worker_id,
          claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,attempt_count=excluded.attempt_count,
          version=excluded.version,payload=excluded.payload,updated_at=now()
      `;
      return value;
    });
  }
  async get(topicId: string, researchVersion?: number) {
    const rows = researchVersion
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.writing_jobs where topic_id=${topicId} and research_version=${researchVersion}`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.writing_jobs where topic_id=${topicId} order by research_version desc limit 1`;
    return rows[0] ? writingJobSchema.parse(rows[0].payload) : undefined;
  }
  async getById(id: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.writing_jobs where id=${id}`;
    return rows[0] ? writingJobSchema.parse(rows[0].payload) : undefined;
  }
  async save(job: WritingJob) {
    const value = writingJobSchema.parse(job);
    await this.sql`
      insert into content_machine.writing_jobs(id,topic_id,research_version,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload)
      values (${value.id},${value.topicId},${value.researchPacketVersion},${value.status},${value.workerId},${value.startedAt},${value.heartbeatAt},${value.attempt},${value.version},${this.sql.json(value)})
      on conflict(topic_id,research_version) do update set status=excluded.status,worker_id=excluded.worker_id,heartbeat_at=excluded.heartbeat_at,
        attempt_count=excluded.attempt_count,version=excluded.version,payload=excluded.payload,updated_at=now()
    `;
  }
}

export class PostgresArticleDraftRepository implements ArticleDraftRepository {
  constructor(private sql: DatabaseClient) {}
  async nextVersion(topicId: string) {
    const rows = await this.sql<
      { version: number }[]
    >`select coalesce(max(draft_version),0)::int+1 as version from content_machine.article_drafts where topic_id=${topicId}`;
    return rows[0]?.version ?? 1;
  }
  async get(topicId: string, version?: number) {
    const rows = version
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.article_drafts where topic_id=${topicId} and draft_version=${version}`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.article_drafts where topic_id=${topicId} order by draft_version desc limit 1`;
    return rows[0] ? articleDraftSchema.parse(rows[0].payload) : undefined;
  }
  async findByImportHash(hash: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.article_drafts where import_hash=${hash}`;
    return rows[0] ? articleDraftSchema.parse(rows[0].payload) : undefined;
  }
  async saveBundle(
    draft: ArticleDraft,
    mdx: string,
    plainText: string,
    quality: DraftQualityReport,
    imported: unknown,
  ) {
    const value = articleDraftSchema.parse(draft);
    const report = draftQualityReportSchema.parse(quality);
    await withTransaction(this.sql, async (tx) => {
      await tx`
        insert into content_machine.article_drafts
          (id,topic_id,draft_version,research_version,import_hash,content_hash,mdx,plain_text,payload,provenance)
        values (${value.id},${value.topicId},${value.version},${value.researchPacketVersion},${value.provenance.importHash},${sha256(mdx)},${mdx},${plainText},${tx.json(value)},${tx.json(toJsonValue(imported))})
      `;
      await tx`
        insert into content_machine.draft_quality_reports (draft_id,topic_id,draft_version,passed,payload)
        values (${value.id},${value.topicId},${value.version},${report.status !== "blocked"},${tx.json(report)})
      `;
    });
  }
  async getQuality(topicId: string, version?: number) {
    const rows = version
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.draft_quality_reports where topic_id=${topicId} and draft_version=${version}`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.draft_quality_reports where topic_id=${topicId} order by draft_version desc limit 1`;
    return rows[0]
      ? draftQualityReportSchema.parse(rows[0].payload)
      : undefined;
  }
}

export class PostgresDraftQualityRepository implements DraftQualityRepository {
  constructor(private drafts: PostgresArticleDraftRepository) {}
  get(topicId: string, version?: number) {
    return this.drafts.getQuality(topicId, version);
  }
}

export class PostgresArticleHistoryRepository implements ArticleHistoryRepository {
  constructor(private sql: DatabaseClient) {}
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.article_history order by occurred_at,id`;
    return rows.map((row) => articleHistoryEntrySchema.parse(row.payload));
  }
  async add(entry: ArticleHistoryEntry) {
    const value = articleHistoryEntrySchema.parse(entry);
    await this
      .sql`insert into content_machine.article_history(id,topic_id,event_type,occurred_at,payload) values (${value.id},${value.topicId},${value.status},${value.date},${this.sql.json(value)}) on conflict(id) do nothing`;
  }
}

export class PostgresWritingTaskRepository implements WritingTaskRepository {
  constructor(private sql: DatabaseClient) {}
  async write(
    topicId: string,
    researchVersion: number,
    files: Record<string, string>,
  ) {
    const input = files["writing-input.json"]
      ? (JSON.parse(files["writing-input.json"]) as unknown)
      : null;
    await this.sql`
      insert into content_machine.writing_tasks(topic_id,research_version,input_payload,files,content_hash)
      values (${topicId},${researchVersion},${input ? this.sql.json(toJsonValue(input)) : null},${this.sql.json(toJsonValue(files))},${sha256(JSON.stringify(files))})
      on conflict(topic_id,research_version) do update set input_payload=excluded.input_payload,files=excluded.files,content_hash=excluded.content_hash
    `;
    return `postgres://content_machine/writing_tasks/${topicId}/v${researchVersion}`;
  }
  async readInput(topicId: string, researchVersion: number) {
    const rows = await this.sql<
      { input_payload: unknown }[]
    >`select input_payload from content_machine.writing_tasks where topic_id=${topicId} and research_version=${researchVersion}`;
    return rows[0]?.input_payload ?? undefined;
  }
}

export class PostgresWritingGateRepository implements WritingGateRepository {
  constructor(private sql: DatabaseClient) {}
  async event(id: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.topic_approved_events where id=${id}`;
    return rows[0]
      ? topicApprovedEventSchema.parse(rows[0].payload)
      : undefined;
  }
  async queue(topicId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.topic_queue_items where topic_id=${topicId}`;
    return rows[0] ? topicQueueItemSchema.parse(rows[0].payload) : undefined;
  }
}
