import {
  PostgresAnalyticsImportRepository,
  PostgresAnalyticsSourceRepository,
  PostgresAnalyticsSyncJobRepository,
  PostgresAnalyticsTaskRepository,
  PostgresArticleMetricsRepository,
  PostgresEditorialInsightRepository,
  PostgresEditorialReportRepository,
  PostgresPerformanceSnapshotRepository,
  PostgresPostedRecordAnalyticsSource,
  PostgresSocialMetricsRepository,
} from "../analytics/postgres-repositories";
import { FilePostedRecordAnalyticsSource } from "../analytics/sources";
import {
  FileAnalyticsImportRepository,
  FileAnalyticsSourceRepository,
  FileAnalyticsSyncJobRepository,
  FileAnalyticsTaskRepository,
  FileArticleMetricsRepository,
  FileEditorialInsightRepository,
  FileEditorialReportRepository,
  FilePerformanceSnapshotRepository,
  FileSocialMetricsRepository,
} from "../analytics/storage";
import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseClient,
} from "../database/client";
import {
  FileWorkflowArtifactRepository,
  PostgresWorkflowArtifactRepository,
  type WorkflowArtifactRepository,
} from "../database/artifacts";
import {
  readStorageConfiguration,
  type StorageBackend,
} from "../database/config";
import { checkDatabaseHealth } from "../database/health";
import {
  PostgresDeploymentStatusRepository,
  PostgresEventConsumerRepository,
  PostgresFinalApprovedEventSource,
  PostgresPublicationJobRepository,
  PostgresPublicationRepository,
  PostgresPublicationRepublishRepository,
  PostgresProductionPublicationArtifactRepository,
  PostgresPublicationVerificationRepository,
} from "../publication/postgres-repositories";
import {
  FileDeploymentStatusRepository,
  FileEventConsumerRepository,
  FileFinalApprovedEventSource,
  FilePublicationJobRepository,
  FilePublicationRepository,
  FilePublicationRepublishRepository,
  FileProductionPublicationArtifactRepository,
  FilePublicationVerificationRepository,
} from "../publication/storage";
import {
  PostgresAssistedResearchImportRepository,
  PostgresApprovedEventRepository,
  PostgresHumanAssistedEvidenceRepository,
  PostgresResearchJobRepository,
  PostgresResearchPacketRepository,
  PostgresResearchSourceExtensionRepository,
  PostgresResearchSourceRepository,
  PostgresResearchTaskRepository,
} from "../research/postgres-repositories";
import {
  FileAssistedResearchImportRepository,
  FileApprovedEventRepository,
  FileHumanAssistedEvidenceRepository,
  FileResearchJobRepository,
  FileResearchPacketRepository,
  FileResearchSourceExtensionRepository,
  FileResearchSourceRepository,
  FileResearchTaskRepository,
} from "../research/storage";
import {
  PostgresDraftPreviewRepository,
  PostgresEditorialIssueRepository,
  PostgresEditorialReviewJobRepository,
  PostgresEditorialReviewRepository,
  PostgresFinalApprovalRepository,
  PostgresFinalApprovedEventRepository,
  PostgresFinalConversationRepository,
  PostgresReviewGateRepository,
  PostgresReviewTaskRepository,
  PostgresRevisionTaskRepository,
} from "../review/postgres-repositories";
import {
  FileDraftPreviewRepository,
  FileEditorialReviewJobRepository,
  FileEditorialReviewRepository,
  FileFinalApprovalRepository,
  FileFinalApprovedEventRepository,
  FileFinalConversationRepository,
  FileReviewGateRepository,
  FileReviewTaskRepository,
  FileRevisionTaskRepository,
} from "../review/storage";
import {
  PostgresSocialApprovalRepository,
  PostgresSocialConversationRepository,
  PostgresSocialExportRepository,
  PostgresSocialGenerationJobRepository,
  PostgresSocialHistoryRepository,
  PostgresSocialPackageRepository,
  PostgresSocialPostedRepository,
  PostgresSocialQualityRepository,
  PostgresSocialRevisionRepository,
  PostgresSocialTaskRepository,
  PostgresSocialAssetRepository,
  PostgresSocialDistributionPlanRepository,
} from "../social/postgres-repositories";
import {
  FileSocialApprovalRepository,
  FileSocialConversationRepository,
  FileSocialExportRepository,
  FileSocialHistoryRepository,
  FileSocialJobRepository,
  FileSocialPackageRepository,
  FileSocialPostedRepository,
  FileSocialQualityRepository,
  FileSocialRevisionRepository,
  FileSocialTaskRepository,
  FileSocialAssetRepository,
  FileSocialDistributionPlanRepository,
} from "../social/storage";
import { PostgresTopicCatalog } from "../telegram/postgres-catalog";
import { PostgresTopicApprovalRepository } from "../telegram/postgres-repository";
import { FileTopicCatalog } from "../telegram/catalog";
import { FileTelegramRepository } from "../telegram/file-repository";
import {
  PostgresArticleDraftRepository,
  PostgresArticleHistoryRepository,
  PostgresDraftQualityRepository,
  PostgresWritingGateRepository,
  PostgresWritingJobRepository,
  PostgresWritingTaskRepository,
} from "../writing/postgres-repositories";
import {
  FileArticleDraftRepository,
  FileArticleHistoryRepository,
  FileDraftQualityRepository,
  FileWritingGateRepository,
  FileWritingJobRepository,
  FileWritingTaskRepository,
} from "../writing/storage";

export interface StoragePaths {
  runs: string;
  telegram: string;
  topicEvents: string;
  research: string;
  researchTasks: string;
  writing: string;
  writingTasks: string;
  review: string;
  reviewTasks: string;
  revisionTasks: string;
  finalApproval: string;
  finalEvents: string;
  publication: string;
  publicationTasks: string;
  social: string;
  socialTasks: string;
  socialRevisionTasks: string;
  analytics: string;
  analyticsTasks: string;
}

export function storagePaths(
  environment: NodeJS.ProcessEnv = process.env,
): StoragePaths {
  return {
    runs: environment.RUN_OUTPUT_DIRECTORY ?? "data/runs",
    telegram: environment.TELEGRAM_STATE_DIRECTORY ?? "data/telegram",
    topicEvents:
      environment.TOPIC_EVENT_DIRECTORY ?? "data/events/topic-approved",
    research: environment.RESEARCH_STATE_DIRECTORY ?? "data/research",
    researchTasks: environment.RESEARCH_TASK_DIRECTORY ?? "data/tasks/research",
    writing: environment.WRITING_STATE_DIRECTORY ?? "data/writing",
    writingTasks: environment.WRITING_TASK_DIRECTORY ?? "data/tasks/writing",
    review: environment.REVIEW_STATE_DIRECTORY ?? "data/review",
    reviewTasks: environment.REVIEW_TASK_DIRECTORY ?? "data/tasks/review",
    revisionTasks: environment.REVISION_TASK_DIRECTORY ?? "data/tasks/revision",
    finalApproval:
      environment.FINAL_APPROVAL_STATE_DIRECTORY ?? "data/final-approval",
    finalEvents:
      environment.ARTICLE_EVENT_DIRECTORY ??
      "data/events/article-final-approved",
    publication: environment.PUBLICATION_STATE_DIRECTORY ?? "data/publication",
    publicationTasks:
      environment.PUBLICATION_TASK_DIRECTORY ?? "data/tasks/publication",
    social: environment.SOCIAL_STATE_DIRECTORY ?? "data/social",
    socialTasks: environment.SOCIAL_TASK_DIRECTORY ?? "data/tasks/social",
    socialRevisionTasks:
      environment.SOCIAL_REVISION_TASK_DIRECTORY ??
      "data/tasks/social-revision",
    analytics: environment.ANALYTICS_STATE_DIRECTORY ?? "data/analytics",
    analyticsTasks:
      environment.ANALYTICS_TASK_DIRECTORY ?? "data/tasks/analytics",
  };
}

export interface RepositoryComposition {
  backend: StorageBackend;
  sql?: DatabaseClient;
  artifacts: WorkflowArtifactRepository;
  telegram:
    | ReturnType<typeof fileComposition>["telegram"]
    | PostgresTopicApprovalRepository;
  catalog: ReturnType<typeof fileComposition>["catalog"] | PostgresTopicCatalog;
  research:
    | ReturnType<typeof fileComposition>["research"]
    | ReturnType<typeof createPostgresRepositories>["research"];
  writing:
    | ReturnType<typeof fileComposition>["writing"]
    | ReturnType<typeof createPostgresRepositories>["writing"];
  review:
    | ReturnType<typeof fileComposition>["review"]
    | ReturnType<typeof createPostgresRepositories>["review"];
  publication:
    | ReturnType<typeof fileComposition>["publication"]
    | ReturnType<typeof createPostgresRepositories>["publication"];
  social:
    | ReturnType<typeof fileComposition>["social"]
    | ReturnType<typeof createPostgresRepositories>["social"];
  analytics:
    | ReturnType<typeof fileComposition>["analytics"]
    | ReturnType<typeof createPostgresRepositories>["analytics"];
  verify(): Promise<void>;
  close(): Promise<void>;
}

export function createRepositoryComposition(
  environment: NodeJS.ProcessEnv = process.env,
): RepositoryComposition {
  const configuration = readStorageConfiguration(environment);
  const paths = storagePaths(environment);
  if (configuration.backend === "file") {
    const repositories = fileComposition(paths);
    return {
      backend: "file",
      ...repositories,
      verify: async () => undefined,
      close: async () => undefined,
    };
  }
  if (!configuration.database)
    throw new Error("Postgres storage selected without database configuration");
  const sql = createDatabaseClient(configuration.database);
  const repositories = createPostgresRepositories(sql);
  return {
    backend: "postgres",
    sql,
    ...repositories,
    verify: async () => {
      const health = await checkDatabaseHealth(sql);
      if (!health.healthy)
        throw new Error(
          `Durable database capability check failed (migration ${health.currentMigration}/${health.expectedMigration}; missing tables: ${health.missingTables.join(",") || "none"})`,
        );
    },
    close: () => closeDatabaseClient(sql),
  };
}

function fileComposition(paths: StoragePaths) {
  const telegram = new FileTelegramRepository(paths.telegram);
  const drafts = new FileArticleDraftRepository(paths.writing);
  const reviews = new FileEditorialReviewRepository(paths.review);
  const socialPackages = new FileSocialPackageRepository(paths.social);
  const researchEvents = new FileApprovedEventRepository(
    paths.topicEvents,
    paths.telegram,
    paths.research,
  );
  const researchPackets = new FileResearchPacketRepository(paths.research);
  return {
    artifacts: new FileWorkflowArtifactRepository(paths.runs),
    telegram,
    catalog: new FileTopicCatalog(paths.runs),
    research: {
      events: researchEvents,
      jobs: new FileResearchJobRepository(paths.research),
      packets: researchPackets,
      extensions: new FileResearchSourceExtensionRepository(paths.research),
      humanEvidence: new FileHumanAssistedEvidenceRepository(paths.research),
      sources: new FileResearchSourceRepository(paths.research),
      cache: new FileResearchSourceRepository(paths.research),
      tasks: new FileResearchTaskRepository(paths.researchTasks),
      imports: new FileAssistedResearchImportRepository(
        researchPackets,
        researchEvents,
      ),
    },
    writing: {
      jobs: new FileWritingJobRepository(paths.writing),
      drafts,
      quality: new FileDraftQualityRepository(drafts),
      history: new FileArticleHistoryRepository(paths.writing),
      tasks: new FileWritingTaskRepository(paths.writingTasks),
      gates: new FileWritingGateRepository(paths.telegram),
    },
    review: {
      jobs: new FileEditorialReviewJobRepository(paths.review),
      reviews,
      issues: reviews,
      tasks: new FileReviewTaskRepository(paths.reviewTasks),
      revisions: new FileRevisionTaskRepository(paths.revisionTasks),
      approvals: new FileFinalApprovalRepository(paths.finalApproval),
      events: new FileFinalApprovedEventRepository(paths.finalEvents),
      previews: new FileDraftPreviewRepository(`${paths.review}/previews`),
      conversations: new FileFinalConversationRepository(paths.review),
      gates: new FileReviewGateRepository(
        paths.research,
        paths.writing,
        paths.telegram,
      ),
    },
    publication: {
      events: new FileFinalApprovedEventSource(paths.finalEvents),
      jobs: new FilePublicationJobRepository(paths.publication),
      publications: new FilePublicationRepository(paths.publication),
      republishes: new FilePublicationRepublishRepository(paths.publication),
      productionArtifacts: new FileProductionPublicationArtifactRepository(
        paths.publication,
      ),
      consumption: new FileEventConsumerRepository(paths.publication),
      deployments: new FileDeploymentStatusRepository(paths.publication),
      verifications: new FilePublicationVerificationRepository(
        paths.publication,
      ),
      tasks: new FileWorkflowArtifactRepository(paths.publicationTasks),
    },
    social: {
      plans: new FileSocialDistributionPlanRepository(paths.social),
      assets: new FileSocialAssetRepository(paths.social),
      jobs: new FileSocialJobRepository(paths.social),
      packages: socialPackages,
      quality: new FileSocialQualityRepository(socialPackages),
      approvals: new FileSocialApprovalRepository(paths.social),
      history: new FileSocialHistoryRepository(paths.social),
      exports: new FileSocialExportRepository(paths.social),
      tasks: new FileSocialTaskRepository(paths.socialTasks),
      posted: new FileSocialPostedRepository(paths.social),
      revisions: new FileSocialRevisionRepository(paths.socialRevisionTasks),
      conversations: new FileSocialConversationRepository(paths.social),
    },
    analytics: {
      sources: new FileAnalyticsSourceRepository(paths.analytics),
      syncJobs: new FileAnalyticsSyncJobRepository(paths.analytics),
      articleMetrics: new FileArticleMetricsRepository(paths.analytics),
      socialMetrics: new FileSocialMetricsRepository(paths.analytics),
      snapshots: new FilePerformanceSnapshotRepository(paths.analytics),
      insights: new FileEditorialInsightRepository(paths.analytics),
      reports: new FileEditorialReportRepository(paths.analytics),
      imports: new FileAnalyticsImportRepository(paths.analytics),
      tasks: new FileAnalyticsTaskRepository(paths.analyticsTasks),
      publications: new FileProductionPublicationArtifactRepository(
        paths.publication,
      ),
      postedRecords: new FilePostedRecordAnalyticsSource(paths.social),
    },
  };
}

export function createPostgresRepositories(sql: DatabaseClient) {
  const artifacts = new PostgresWorkflowArtifactRepository(sql);
  const drafts = new PostgresArticleDraftRepository(sql);
  const reviews = new PostgresEditorialReviewRepository(sql);
  const packages = new PostgresSocialPackageRepository(sql);
  return {
    artifacts,
    telegram: new PostgresTopicApprovalRepository(sql),
    catalog: new PostgresTopicCatalog(sql),
    research: {
      events: new PostgresApprovedEventRepository(sql),
      jobs: new PostgresResearchJobRepository(sql),
      packets: new PostgresResearchPacketRepository(sql),
      extensions: new PostgresResearchSourceExtensionRepository(sql),
      humanEvidence: new PostgresHumanAssistedEvidenceRepository(sql),
      sources: new PostgresResearchSourceRepository(sql),
      cache: new PostgresResearchSourceRepository(sql),
      tasks: new PostgresResearchTaskRepository(sql),
      imports: new PostgresAssistedResearchImportRepository(sql),
    },
    writing: {
      jobs: new PostgresWritingJobRepository(sql),
      drafts,
      quality: new PostgresDraftQualityRepository(drafts),
      history: new PostgresArticleHistoryRepository(sql),
      tasks: new PostgresWritingTaskRepository(sql),
      gates: new PostgresWritingGateRepository(sql),
    },
    review: {
      jobs: new PostgresEditorialReviewJobRepository(sql),
      reviews,
      issues: new PostgresEditorialIssueRepository(reviews),
      tasks: new PostgresReviewTaskRepository(sql),
      revisions: new PostgresRevisionTaskRepository(sql),
      approvals: new PostgresFinalApprovalRepository(sql),
      events: new PostgresFinalApprovedEventRepository(sql),
      previews: new PostgresDraftPreviewRepository(sql),
      conversations: new PostgresFinalConversationRepository(sql),
      gates: new PostgresReviewGateRepository(sql),
    },
    publication: {
      events: new PostgresFinalApprovedEventSource(sql),
      jobs: new PostgresPublicationJobRepository(sql),
      publications: new PostgresPublicationRepository(sql),
      republishes: new PostgresPublicationRepublishRepository(sql),
      productionArtifacts: new PostgresProductionPublicationArtifactRepository(
        sql,
      ),
      consumption: new PostgresEventConsumerRepository(sql),
      deployments: new PostgresDeploymentStatusRepository(sql),
      verifications: new PostgresPublicationVerificationRepository(sql),
      tasks: artifacts,
    },
    social: {
      plans: new PostgresSocialDistributionPlanRepository(sql),
      assets: new PostgresSocialAssetRepository(sql),
      jobs: new PostgresSocialGenerationJobRepository(sql),
      packages,
      quality: new PostgresSocialQualityRepository(packages),
      approvals: new PostgresSocialApprovalRepository(sql),
      history: new PostgresSocialHistoryRepository(sql),
      exports: new PostgresSocialExportRepository(sql),
      tasks: new PostgresSocialTaskRepository(sql),
      posted: new PostgresSocialPostedRepository(sql),
      revisions: new PostgresSocialRevisionRepository(sql),
      conversations: new PostgresSocialConversationRepository(sql),
    },
    analytics: {
      sources: new PostgresAnalyticsSourceRepository(sql),
      syncJobs: new PostgresAnalyticsSyncJobRepository(sql),
      articleMetrics: new PostgresArticleMetricsRepository(sql),
      socialMetrics: new PostgresSocialMetricsRepository(sql),
      snapshots: new PostgresPerformanceSnapshotRepository(sql),
      insights: new PostgresEditorialInsightRepository(sql),
      reports: new PostgresEditorialReportRepository(sql),
      imports: new PostgresAnalyticsImportRepository(sql),
      tasks: new PostgresAnalyticsTaskRepository(sql),
      publications: new PostgresProductionPublicationArtifactRepository(sql),
      postedRecords: new PostgresPostedRecordAnalyticsSource(sql),
    },
  };
}
