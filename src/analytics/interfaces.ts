import type { ProductionPublicationArtifact } from "../publication/models";
import type { PostedRecord } from "../social/models";
import type {
  AnalyticsImport,
  AnalyticsProviderName,
  AnalyticsSource,
  AnalyticsSyncJob,
  ArticleMetrics,
  AssistedAnalysis,
  EditorialInsight,
  EditorialReport,
  InsightAction,
  PerformanceSnapshot,
  SocialMetrics,
} from "./models";

export interface AnalyticsCapabilities {
  metrics: string[];
  dimensions: string[];
  supportsPagination: boolean;
  liveAccess: boolean;
}
export interface ArticleMetricRequest {
  canonicalUrls: string[];
  windowStart: string;
  windowEnd: string;
  dimensions: string[];
}
export interface SiteMetricRequest {
  windowStart: string;
  windowEnd: string;
}
export interface AnalyticsProvider {
  readonly provider: AnalyticsProviderName;
  getCapabilities(): Promise<AnalyticsCapabilities>;
  collectArticleMetrics(input: ArticleMetricRequest): Promise<unknown[]>;
  collectSiteMetrics(input: SiteMetricRequest): Promise<unknown>;
}
export interface SocialMetricRequest {
  postUrls: string[];
  windowStart: string;
  windowEnd: string;
}
export interface SocialMetricsProvider {
  collectPostMetrics(input: SocialMetricRequest): Promise<unknown[]>;
}
export interface PublicationAnalyticsSource {
  listPublications(): Promise<ProductionPublicationArtifact[]>;
  listPostedRecords(): Promise<PostedRecord[]>;
}
export interface AnalyticsSourceRepository {
  save(value: AnalyticsSource): Promise<void>;
  list(): Promise<AnalyticsSource[]>;
}
export interface AnalyticsSyncJobRepository {
  save(value: AnalyticsSyncJob): Promise<void>;
  get(id: string): Promise<AnalyticsSyncJob | undefined>;
  list(): Promise<AnalyticsSyncJob[]>;
}
export interface ArticleMetricsRepository {
  saveMany(values: ArticleMetrics[]): Promise<void>;
  list(publicationId?: string): Promise<ArticleMetrics[]>;
}
export interface SocialMetricsRepository {
  saveMany(values: SocialMetrics[]): Promise<void>;
  list(publicationId?: string): Promise<SocialMetrics[]>;
}
export interface PerformanceSnapshotRepository {
  save(value: PerformanceSnapshot): Promise<boolean>;
  get(
    publicationId: string,
    period: string,
  ): Promise<PerformanceSnapshot | undefined>;
  list(): Promise<PerformanceSnapshot[]>;
}
export interface EditorialInsightRepository {
  saveMany(values: EditorialInsight[]): Promise<void>;
  list(): Promise<EditorialInsight[]>;
  action(value: InsightAction): Promise<void>;
  actions(insightId: string): Promise<InsightAction[]>;
}
export interface EditorialReportRepository {
  save(value: EditorialReport, files: Record<string, string>): Promise<boolean>;
  get(id: string): Promise<EditorialReport | undefined>;
  list(): Promise<EditorialReport[]>;
}
export interface AnalyticsImportRepository {
  findByHash(hash: string): Promise<AnalyticsImport | undefined>;
  save(value: AnalyticsImport): Promise<void>;
  list(): Promise<AnalyticsImport[]>;
  removeOlderThan(cutoff: string, dryRun: boolean): Promise<string[]>;
}
export interface AnalyticsTaskRepository {
  write(reportId: string, files: Record<string, string>): Promise<string>;
  saveAnalysis(reportId: string, value: AssistedAnalysis): Promise<void>;
  getAnalysis(reportId: string): Promise<AssistedAnalysis | undefined>;
}
