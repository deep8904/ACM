import type { DatabaseClient } from "../database/client";
import { withTransaction } from "../database/client";
import { stableId } from "../database/hash";
import { toJsonValue } from "../database/json";
import { productionPublicationArtifactSchema } from "../publication/models";
import { postedRecordSchema } from "../social/models";
import type {
  AnalyticsImportRepository,
  AnalyticsSourceRepository,
  AnalyticsSyncJobRepository,
  AnalyticsTaskRepository,
  ArticleMetricsRepository,
  EditorialInsightRepository,
  EditorialReportRepository,
  PerformanceSnapshotRepository,
  PublicationAnalyticsSource,
  SocialMetricsRepository,
} from "./interfaces";
import {
  analyticsImportSchema,
  analyticsSourceSchema,
  analyticsSyncJobSchema,
  articleMetricsSchema,
  assistedAnalysisSchema,
  editorialInsightSchema,
  editorialReportSchema,
  insightActionSchema,
  performanceSnapshotSchema,
  socialMetricsSchema,
  type AnalyticsImport,
  type AnalyticsSource,
  type AnalyticsSyncJob,
  type ArticleMetrics,
  type AssistedAnalysis,
  type EditorialInsight,
  type EditorialReport,
  type InsightAction,
  type PerformanceSnapshot,
  type SocialMetrics,
} from "./models";

type PayloadRow = { payload: unknown };

export class PostgresAnalyticsSourceRepository implements AnalyticsSourceRepository {
  constructor(private sql: DatabaseClient) {}
  async save(source: AnalyticsSource) {
    const value = analyticsSourceSchema.parse(source);
    await this
      .sql`insert into content_machine.analytics_sources(id,provider,enabled,payload,updated_at) values (${value.id},${value.provider},${value.status !== "disabled"},${this.sql.json(value)},now()) on conflict(id) do update set provider=excluded.provider,enabled=excluded.enabled,payload=excluded.payload,updated_at=now()`;
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.analytics_sources order by id`;
    return rows.map((row) => analyticsSourceSchema.parse(row.payload));
  }
}

export class PostgresAnalyticsSyncJobRepository implements AnalyticsSyncJobRepository {
  constructor(private sql: DatabaseClient) {}
  async save(job: AnalyticsSyncJob) {
    const value = analyticsSyncJobSchema.parse(job);
    await this.sql`
      insert into content_machine.analytics_sync_jobs(id,status,window_start,window_end,attempt_count,version,payload,updated_at)
      values (${value.id},${value.status},${value.windowStart},${value.windowEnd},0,${value.version},${this.sql.json(value)},now())
      on conflict(id) do update set status=excluded.status,window_start=excluded.window_start,window_end=excluded.window_end,
        version=excluded.version,payload=excluded.payload,updated_at=now()
    `;
  }
  async get(id: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.analytics_sync_jobs where id=${id}`;
    return rows[0] ? analyticsSyncJobSchema.parse(rows[0].payload) : undefined;
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.analytics_sync_jobs order by created_at,id`;
    return rows.map((row) => analyticsSyncJobSchema.parse(row.payload));
  }
}

export class PostgresArticleMetricsRepository implements ArticleMetricsRepository {
  constructor(private sql: DatabaseClient) {}
  async saveMany(metrics: ArticleMetrics[]) {
    const values = metrics.map((item) => articleMetricsSchema.parse(item));
    await withTransaction(this.sql, async (tx) => {
      for (const value of values) {
        await tx`
          insert into content_machine.article_metrics(id,publication_id,provider,observed_at,window_start,window_end,import_hash,payload)
          values (${value.id},${value.publicationId},${value.providers[0]!},${value.collectedAt},${value.windowStart},${value.windowEnd},${value.importId},${tx.json(toJsonValue(value))})
          on conflict(id) do nothing
        `;
      }
    });
  }
  async list(publicationId?: string) {
    const rows = publicationId
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.article_metrics where publication_id=${publicationId} order by observed_at,id`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.article_metrics order by observed_at,id`;
    return rows.map((row) => articleMetricsSchema.parse(row.payload));
  }
}

export class PostgresSocialMetricsRepository implements SocialMetricsRepository {
  constructor(private sql: DatabaseClient) {}
  async saveMany(metrics: SocialMetrics[]) {
    const values = metrics.map((item) => socialMetricsSchema.parse(item));
    await withTransaction(this.sql, async (tx) => {
      for (const value of values) {
        await tx`
          insert into content_machine.social_metrics(id,publication_id,platform,observed_at,window_start,window_end,import_hash,payload)
          values (${value.id},${value.publicationId},${value.platform},${value.collectedAt},${value.windowStart},${value.windowEnd},${value.importId},${tx.json(toJsonValue(value))})
          on conflict(id) do nothing
        `;
      }
    });
  }
  async list(publicationId?: string) {
    const rows = publicationId
      ? await this.sql<
          PayloadRow[]
        >`select payload from content_machine.social_metrics where publication_id=${publicationId} order by observed_at,id`
      : await this.sql<
          PayloadRow[]
        >`select payload from content_machine.social_metrics order by observed_at,id`;
    return rows.map((row) => socialMetricsSchema.parse(row.payload));
  }
}

export class PostgresPerformanceSnapshotRepository implements PerformanceSnapshotRepository {
  constructor(private sql: DatabaseClient) {}
  async save(snapshot: PerformanceSnapshot) {
    const value = performanceSnapshotSchema.parse(snapshot);
    const rows = await this.sql<
      { id: string }[]
    >`insert into content_machine.performance_snapshots(id,publication_id,period,snapshot_hash,payload,created_at) values (${value.id},${value.publicationId},${value.period},${value.contentHash},${this.sql.json(toJsonValue(value))},${value.createdAt}) on conflict do nothing returning id`;
    return Boolean(rows[0]);
  }
  async get(publicationId: string, period: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.performance_snapshots where publication_id=${publicationId} and period=${period}`;
    return rows[0]
      ? performanceSnapshotSchema.parse(rows[0].payload)
      : undefined;
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.performance_snapshots order by created_at,id`;
    return rows.map((row) => performanceSnapshotSchema.parse(row.payload));
  }
}

export class PostgresEditorialInsightRepository implements EditorialInsightRepository {
  constructor(private sql: DatabaseClient) {}
  async saveMany(insights: EditorialInsight[]) {
    const values = insights.map((item) => editorialInsightSchema.parse(item));
    await withTransaction(this.sql, async (tx) => {
      for (const value of values)
        await tx`insert into content_machine.editorial_insights(id,insight_type,payload,created_at) values (${value.id},${value.category},${tx.json(toJsonValue(value))},${value.createdAt}) on conflict(id) do nothing`;
    });
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.editorial_insights order by created_at,id`;
    return rows.map((row) => editorialInsightSchema.parse(row.payload));
  }
  async action(action: InsightAction) {
    const value = insightActionSchema.parse(action);
    const id = stableId("insightaction", `${value.insightId}:${value.version}`);
    await this
      .sql`insert into content_machine.insight_actions(id,insight_id,action,payload,created_at) values (${id},${value.insightId},${value.action},${this.sql.json(value)},${value.createdAt}) on conflict(id) do nothing`;
  }
  async actions(insightId: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.insight_actions where insight_id=${insightId} order by created_at,id`;
    return rows.map((row) => insightActionSchema.parse(row.payload));
  }
}

export class PostgresEditorialReportRepository implements EditorialReportRepository {
  constructor(private sql: DatabaseClient) {}
  async save(report: EditorialReport, files: Record<string, string>) {
    const value = editorialReportSchema.parse(report);
    const markdown =
      Object.entries(files).find(([name]) => name.endsWith(".md"))?.[1] ?? "";
    const rows = await this.sql<
      { id: string }[]
    >`insert into content_machine.editorial_reports(id,period,report_hash,markdown,files,payload,created_at) values (${value.id},${value.reportType},${value.contentHash},${markdown},${this.sql.json(toJsonValue(files))},${this.sql.json(toJsonValue(value))},${value.generatedAt}) on conflict do nothing returning id`;
    return Boolean(rows[0]);
  }
  async get(id: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.editorial_reports where id=${id}`;
    return rows[0] ? editorialReportSchema.parse(rows[0].payload) : undefined;
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.editorial_reports order by created_at,id`;
    return rows.map((row) => editorialReportSchema.parse(row.payload));
  }
}

export class PostgresAnalyticsImportRepository implements AnalyticsImportRepository {
  constructor(private sql: DatabaseClient) {}
  async findByHash(hash: string) {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.analytics_imports where import_hash=${hash}`;
    return rows[0] ? analyticsImportSchema.parse(rows[0].payload) : undefined;
  }
  async save(record: AnalyticsImport) {
    const value = analyticsImportSchema.parse(record);
    await this
      .sql`insert into content_machine.analytics_imports(id,import_hash,source_type,payload,imported_at) values (${value.id},${value.fileHash},${value.provider},${this.sql.json(value)},${value.importedAt}) on conflict do nothing`;
  }
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.analytics_imports order by imported_at,id`;
    return rows.map((row) => analyticsImportSchema.parse(row.payload));
  }
  async removeOlderThan(cutoff: string, dryRun: boolean) {
    const rows = dryRun
      ? await this.sql<
          { id: string }[]
        >`select id from content_machine.analytics_imports where imported_at<${cutoff} order by id`
      : await this.sql<
          { id: string }[]
        >`delete from content_machine.analytics_imports where imported_at<${cutoff} returning id`;
    return rows.map((row) => row.id).sort();
  }
}

export class PostgresAnalyticsTaskRepository implements AnalyticsTaskRepository {
  constructor(private sql: DatabaseClient) {}
  async write(reportId: string, files: Record<string, string>) {
    await this
      .sql`insert into content_machine.analytics_tasks(report_id,files) values (${reportId},${this.sql.json(toJsonValue(files))}) on conflict(report_id) do update set files=excluded.files,updated_at=now()`;
    return `postgres://content_machine/analytics_tasks/${reportId}`;
  }
  async saveAnalysis(reportId: string, analysis: AssistedAnalysis) {
    const value = assistedAnalysisSchema.parse(analysis);
    await this
      .sql`update content_machine.analytics_tasks set analysis_payload=${this.sql.json(toJsonValue(value))},updated_at=now() where report_id=${reportId}`;
  }
  async getAnalysis(reportId: string) {
    const rows = await this.sql<
      { analysis_payload: unknown }[]
    >`select analysis_payload from content_machine.analytics_tasks where report_id=${reportId}`;
    return rows[0]?.analysis_payload
      ? assistedAnalysisSchema.parse(rows[0].analysis_payload)
      : undefined;
  }
}

export class PostgresPublicationAnalyticsSource implements PublicationAnalyticsSource {
  constructor(private sql: DatabaseClient) {}
  async listPublications() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.production_publication_artifacts order by verified_at,id`;
    return rows.map((row) =>
      productionPublicationArtifactSchema.parse(row.payload),
    );
  }
  async listPostedRecords() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_posted_records order by posted_at,id`;
    return rows.map((row) => postedRecordSchema.parse(row.payload));
  }
}

export class PostgresPostedRecordAnalyticsSource {
  constructor(private sql: DatabaseClient) {}
  async list() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.social_posted_records order by posted_at,id`;
    return rows.map((row) => postedRecordSchema.parse(row.payload));
  }
}
