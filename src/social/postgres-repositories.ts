import type { DatabaseClient } from "../database/client";
import { withTransaction } from "../database/client";
import { sha256, stableId } from "../database/hash";
import { toJsonValue } from "../database/json";
import type { ProductionPublicationArtifact } from "../publication/models";
import type {
  SocialApprovalRepository,
  SocialConversationRepository,
  SocialExportRepository,
  SocialGenerationJobRepository,
  SocialHistoryRepository,
  SocialPackageRepository,
  SocialPostedRepository,
  SocialQualityRepository,
  SocialRevisionRepository,
  SocialTaskRepository,
  SocialAssetRepository,
  SocialDistributionPlanRepository,
} from "./interfaces";
import {
  postedRecordSchema,
  socialApprovalSchema,
  socialConversationSchema,
  socialExportSchema,
  socialHistorySchema,
  socialJobSchema,
  socialPackageSchema,
  socialQualitySchema,
  socialRevisionSchema,
  type PostedRecord,
  type SocialApproval,
  type SocialConversation,
  type SocialExport,
  type SocialGenerationJob,
  type SocialHistory,
  type SocialPackage,
  type SocialQuality,
  type SocialRevision,
  socialAssetSchema,
  socialDistributionEventSchema,
  socialDistributionPlanSchema,
  type SocialAsset,
  type SocialDistributionEvent,
  type SocialDistributionPlan,
} from "./models";

type PayloadRow = { payload: unknown };

export class PostgresSocialDistributionPlanRepository implements SocialDistributionPlanRepository {
  constructor(private sql: DatabaseClient) {}
  async get(id: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.social_distribution_plans where id=${id}
    `;
    return rows[0]
      ? socialDistributionPlanSchema.parse(rows[0].payload)
      : undefined;
  }
  async getByPublication(publicationId: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.social_distribution_plans
      where publication_id=${publicationId} order by updated_at desc limit 1
    `;
    return rows[0]
      ? socialDistributionPlanSchema.parse(rows[0].payload)
      : undefined;
  }
  async getByShortId(shortId: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.social_distribution_plans
      where right(id, 12)=${shortId} limit 1
    `;
    return rows[0]
      ? socialDistributionPlanSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(plan: SocialDistributionPlan) {
    const value = socialDistributionPlanSchema.parse(plan);
    await this.sql`
      insert into content_machine.social_distribution_plans
        (id,publication_id,publication_content_hash,status,selection_revision,payload,created_at,updated_at)
      values (${value.id},${value.publicationId},${value.articleContentHash},${value.status},${value.selectionRevision},${this.sql.json(value)},${value.createdAt},${value.updatedAt})
      on conflict(id) do update set status=excluded.status,selection_revision=excluded.selection_revision,
        payload=excluded.payload,updated_at=excluded.updated_at
      where (content_machine.social_distribution_plans.payload->>'version')::int < ${value.version}
    `;
  }
  async appendEvent(event: SocialDistributionEvent) {
    const value = socialDistributionEventSchema.parse(event);
    const rows = await this.sql<{ id: string }[]>`
      insert into content_machine.social_distribution_events
        (id,plan_id,sequence,event_type,callback_query_id,payload,created_at)
      values (${value.id},${value.planId},${value.sequence},${value.type},${value.callbackQueryId ?? null},${this.sql.json(value)},${value.createdAt})
      on conflict do nothing returning id
    `;
    return rows.length === 1;
  }
  async listEvents(planId: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.social_distribution_events
      where plan_id=${planId} order by sequence
    `;
    return rows.map((row) => socialDistributionEventSchema.parse(row.payload));
  }
}

export class PostgresSocialAssetRepository implements SocialAssetRepository {
  constructor(private sql: DatabaseClient) {}
  async findByContentHash(planId: string, contentHash: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.social_assets
      where plan_id=${planId} and content_hash=${contentHash} limit 1
    `;
    return rows[0] ? socialAssetSchema.parse(rows[0].payload) : undefined;
  }
  async save(asset: SocialAsset, bytes: Uint8Array) {
    const parsed = socialAssetSchema.parse(asset);
    const value = socialAssetSchema.parse({
      ...parsed,
      path: `postgres://content_machine/social_assets/${parsed.id}`,
    });
    await this.sql`
      insert into content_machine.social_assets
        (id,plan_id,package_id,platform,content_hash,media_type,bytes,payload,created_at)
      values (${value.id},${value.planId},${value.packageId},${value.platform},${value.contentHash},'image/png',${bytes},${this.sql.json(value)},${value.createdAt})
      on conflict(id) do nothing
    `;
    const existing = await this.get(value.id);
    if (!existing || existing.contentHash !== value.contentHash)
      throw new Error("Social asset identity conflict");
    return existing;
  }
  private async get(id: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.social_assets where id=${id}
    `;
    return rows[0] ? socialAssetSchema.parse(rows[0].payload) : undefined;
  }
  async list(planId: string) {
    const rows = await this.sql<PayloadRow[]>`
      select payload from content_machine.social_assets where plan_id=${planId} order by platform,id
    `;
    return rows.map((row) => socialAssetSchema.parse(row.payload));
  }
  async read(assetId: string) {
    const rows = await this.sql<{ bytes: Uint8Array }[]>`
      select bytes from content_machine.social_assets where id=${assetId}
    `;
    return rows[0]?.bytes;
  }
}

export class PostgresSocialGenerationJobRepository implements SocialGenerationJobRepository {
  constructor(private sql: DatabaseClient) {}
  async get(publicationId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_generation_jobs where publication_id=${publicationId}`;
    return rows[0] ? socialJobSchema.parse(rows[0].payload) : undefined;
  }
  async claim(
    record: ProductionPublicationArtifact,
    workerId: string,
    now: string,
  ) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<
        PayloadRow[]
      >`select payload from content_machine.social_generation_jobs where publication_id=${record.id} for update`;
      const old = rows[0] ? socialJobSchema.parse(rows[0].payload) : undefined;
      if (old && !["failed", "blocked", "cancelled"].includes(old.status))
        return old;
      const value = socialJobSchema.parse({
        id: stableId("socialjob", record.id),
        publicationId: record.id,
        topicId: record.topicId,
        articleSlug: record.slug,
        articleContentHash: record.contentHash,
        attempt: (old?.attempt ?? 0) + 1,
        status: "claimed",
        startedAt: old?.startedAt ?? now,
        heartbeatAt: now,
        workerId,
        version: (old?.version ?? 0) + 1,
      });
      await tx`
        insert into content_machine.social_generation_jobs
          (id,publication_id,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload,updated_at)
        values (${value.id},${record.id},${value.status},${workerId},${now},${now},${value.attempt},${value.version},${tx.json(value)},now())
        on conflict(publication_id) do update set status=excluded.status,worker_id=excluded.worker_id,
          claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,attempt_count=excluded.attempt_count,
          version=excluded.version,payload=excluded.payload,updated_at=now()
      `;
      return value;
    });
  }
  async save(job: SocialGenerationJob) {
    const value = socialJobSchema.parse(job);
    await this.sql`
      insert into content_machine.social_generation_jobs(id,publication_id,status,worker_id,claimed_at,heartbeat_at,attempt_count,version,payload)
      values (${value.id},${value.publicationId},${value.status},${value.workerId},${value.startedAt},${value.heartbeatAt},${value.attempt},${value.version},${this.sql.json(value)})
      on conflict(publication_id) do update set status=excluded.status,worker_id=excluded.worker_id,heartbeat_at=excluded.heartbeat_at,
        attempt_count=excluded.attempt_count,version=excluded.version,payload=excluded.payload,updated_at=now()
    `;
  }
}

export class PostgresSocialPackageRepository implements SocialPackageRepository {
  constructor(private sql: DatabaseClient) {}
  async nextVersion(publicationId: string) {
    const rows = await this.sql<
      { version: number }[]
    >`select coalesce(max(package_version),0)::int+1 as version from content_machine.social_packages where publication_id=${publicationId}`;
    return rows[0]?.version ?? 1;
  }
  async get(publicationId: string, version?: number) {
    const rows = version
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.social_packages where publication_id=${publicationId} and package_version=${version}`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.social_packages where publication_id=${publicationId} order by package_version desc limit 1`;
    return rows[0] ? socialPackageSchema.parse(rows[0].payload) : undefined;
  }
  async findByImportHash(hash: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_packages where import_hash=${hash}`;
    return rows[0] ? socialPackageSchema.parse(rows[0].payload) : undefined;
  }
  async save(
    pkg: SocialPackage,
    quality: SocialQuality[],
    provenance: unknown,
  ) {
    const value = socialPackageSchema.parse(pkg);
    const reports = quality.map((item) => socialQualitySchema.parse(item));
    await withTransaction(this.sql, async (tx) => {
      await tx`
        insert into content_machine.social_packages
          (id,publication_id,package_version,publication_content_hash,import_hash,payload,provenance)
        values (${value.id},${value.publicationId},${value.version},${value.articleContentHash},${value.provenance.importHash},${tx.json(value)},${tx.json(toJsonValue(provenance))})
      `;
      for (const item of value.items) {
        await tx`insert into content_machine.social_items(id,package_id,platform,content_hash,payload) values (${item.id},${value.id},${item.platform},${sha256(JSON.stringify(item))},${tx.json(item)})`;
      }
      for (const report of reports) {
        await tx`insert into content_machine.social_quality_reports(package_id,item_id,passed,payload) values (${value.id},${report.platformItemId},${report.status !== "blocked"},${tx.json(report)})`;
      }
    });
  }
  async getQuality(publicationId: string, version: number) {
    const rows = await this.sql<PayloadRow[]>`
      select q.payload from content_machine.social_quality_reports q
      join content_machine.social_packages p on p.id=q.package_id
      where p.publication_id=${publicationId} and p.package_version=${version} order by q.item_id
    `;
    return rows.map((row) => socialQualitySchema.parse(row.payload));
  }
}

export class PostgresSocialQualityRepository implements SocialQualityRepository {
  constructor(private packages: PostgresSocialPackageRepository) {}
  get(publicationId: string, version: number) {
    return this.packages.getQuality(publicationId, version);
  }
}

export class PostgresSocialApprovalRepository implements SocialApprovalRepository {
  constructor(private sql: DatabaseClient) {}
  async get(packageId: string, itemId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_approvals where package_id=${packageId} and item_id=${itemId}`;
    return rows[0] ? socialApprovalSchema.parse(rows[0].payload) : undefined;
  }
  async save(approval: SocialApproval) {
    const value = socialApprovalSchema.parse(approval);
    const rows = await this.sql<
      { content_hash: string }[]
    >`select content_hash from content_machine.social_items where id=${value.platformItemId} and package_id=${value.packageId}`;
    if (!rows[0]) throw new Error("Social item does not exist for approval");
    await this.sql`
      insert into content_machine.social_approvals(package_id,item_id,item_content_hash,status,scheduled_for,payload,updated_at)
      values (${value.packageId},${value.platformItemId},${rows[0].content_hash},${value.status},${value.scheduledAt ?? null},${this.sql.json(value)},${value.updatedAt})
      on conflict(package_id,item_id) do update set item_content_hash=excluded.item_content_hash,status=excluded.status,
        scheduled_for=excluded.scheduled_for,payload=excluded.payload,updated_at=excluded.updated_at
        where (content_machine.social_approvals.payload->>'version')::int < ${value.version}
    `;
  }
  async list(packageId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_approvals where package_id=${packageId} order by item_id`;
    return rows.map((row) => socialApprovalSchema.parse(row.payload));
  }
}

export class PostgresSocialHistoryRepository implements SocialHistoryRepository {
  constructor(private sql: DatabaseClient) {}
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_history order by occurred_at,id`;
    return rows.map((row) => socialHistorySchema.parse(row.payload));
  }
  async add(history: SocialHistory) {
    const value = socialHistorySchema.parse(history);
    const id = stableId(
      "socialhistory",
      `${value.publicationId}:${value.platform}:${value.contentHash}:${value.status}`,
    );
    const occurred =
      value.postedDate ??
      value.scheduledDate ??
      value.approvedDate ??
      new Date(0).toISOString();
    await this
      .sql`insert into content_machine.social_history(id,publication_id,event_type,occurred_at,payload) values (${id},${value.publicationId},${value.status},${occurred},${this.sql.json(value)}) on conflict(id) do nothing`;
  }
}

export class PostgresSocialExportRepository implements SocialExportRepository {
  constructor(private sql: DatabaseClient) {}
  async write(
    publicationId: string,
    version: number,
    files: Record<string, string>,
    records: SocialExport[],
  ) {
    const values = records.map((record) => socialExportSchema.parse(record));
    await withTransaction(this.sql, async (tx) => {
      for (const value of values) {
        await tx`insert into content_machine.social_exports(id,publication_id,package_version,content_hash,files,payload,created_at) values (${value.id},${publicationId},${version},${value.contentHash},${tx.json(toJsonValue(files))},${tx.json(value)},${value.createdAt}) on conflict(id) do nothing`;
      }
    });
    return values;
  }
  async list(publicationId: string, version: number) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_exports where publication_id=${publicationId} and package_version=${version} order by id`;
    return rows.map((row) => socialExportSchema.parse(row.payload));
  }
  async readFiles(publicationId: string, version: number) {
    const rows = await this.sql<{ files: unknown }[]>`
      select files from content_machine.social_exports
      where publication_id=${publicationId} and package_version=${version}
      order by created_at,id
    `;
    const files: Record<string, string> = {};
    for (const row of rows) {
      if (
        !row.files ||
        typeof row.files !== "object" ||
        Array.isArray(row.files)
      )
        continue;
      for (const [name, body] of Object.entries(row.files))
        if (typeof body === "string") files[name] = body;
    }
    return files;
  }
  location(publicationId: string, version: number) {
    return `postgres://content_machine/social_exports/${publicationId}/v${version}`;
  }
}

export class PostgresSocialTaskRepository implements SocialTaskRepository {
  constructor(private sql: DatabaseClient) {}
  async write(
    publicationId: string,
    version: number,
    files: Record<string, string>,
  ) {
    const input = files["social-input.json"]
      ? (JSON.parse(files["social-input.json"]) as unknown)
      : null;
    await this
      .sql`insert into content_machine.social_tasks(publication_id,package_version,input_payload,files) values (${publicationId},${version},${input ? this.sql.json(toJsonValue(input)) : null},${this.sql.json(toJsonValue(files))}) on conflict(publication_id,package_version) do update set input_payload=excluded.input_payload,files=excluded.files`;
    return `postgres://content_machine/social_tasks/${publicationId}/v${version}`;
  }
  async readInput(publicationId: string, version: number) {
    const rows = await this.sql<
      { input_payload: unknown }[]
    >`select input_payload from content_machine.social_tasks where publication_id=${publicationId} and package_version=${version}`;
    return rows[0]?.input_payload ?? undefined;
  }
}

export class PostgresSocialPostedRepository implements SocialPostedRepository {
  constructor(private sql: DatabaseClient) {}
  async save(record: PostedRecord) {
    const value = postedRecordSchema.parse(record);
    const id = stableId("posted", `${value.publicationId}:${value.platform}`);
    await this
      .sql`insert into content_machine.social_posted_records(id,publication_id,platform,post_url,payload,posted_at) values (${id},${value.publicationId},${value.platform},${value.postUrl},${this.sql.json(value)},${value.postedAt}) on conflict(publication_id,platform) do update set post_url=excluded.post_url,payload=excluded.payload,posted_at=excluded.posted_at`;
  }
  async get(publicationId: string, platform: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_posted_records where publication_id=${publicationId} and platform=${platform}`;
    return rows[0] ? postedRecordSchema.parse(rows[0].payload) : undefined;
  }
}

export class PostgresSocialRevisionRepository implements SocialRevisionRepository {
  constructor(private sql: DatabaseClient) {}
  async write(
    publicationId: string,
    version: number,
    files: Record<string, string>,
    request: SocialRevision,
  ) {
    const value = socialRevisionSchema.parse(request);
    await this
      .sql`insert into content_machine.social_revisions(publication_id,package_version,files,payload,created_at) values (${publicationId},${version},${this.sql.json(toJsonValue(files))},${this.sql.json(value)},${value.createdAt}) on conflict(publication_id,package_version) do update set files=excluded.files,payload=excluded.payload`;
    return `postgres://content_machine/social_revisions/${publicationId}/v${version}`;
  }
  async get(publicationId: string, version: number) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_revisions where publication_id=${publicationId} and package_version=${version}`;
    return rows[0] ? socialRevisionSchema.parse(rows[0].payload) : undefined;
  }
}

export class PostgresSocialConversationRepository implements SocialConversationRepository {
  constructor(private sql: DatabaseClient) {}
  async get(chatId: string, userId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_conversations where chat_id=${chatId} and user_id=${userId} and expires_at>now()`;
    return rows[0]
      ? socialConversationSchema.parse(rows[0].payload)
      : undefined;
  }
  async save(conversation: SocialConversation) {
    const value = socialConversationSchema.parse(conversation);
    await this
      .sql`insert into content_machine.social_conversations(chat_id,user_id,state,publication_id,version,expires_at,payload) values (${value.chatId},${value.userId},${value.state},${value.publicationId},1,${value.expiresAt},${this.sql.json(value)}) on conflict(chat_id,user_id) do update set state=excluded.state,publication_id=excluded.publication_id,version=content_machine.social_conversations.version+1,expires_at=excluded.expires_at,payload=excluded.payload,updated_at=now()`;
  }
  async clear(chatId: string, userId: string) {
    await this
      .sql`delete from content_machine.social_conversations where chat_id=${chatId} and user_id=${userId}`;
  }
}
