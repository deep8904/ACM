import { z } from "zod";
import { socialPlatformSchema } from "../social/models";

const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{24}$`));
const nullableCount = z.number().int().nonnegative().nullable();
const nullableNumber = z.number().nonnegative().nullable();
const nullableRate = z.number().min(0).max(1).nullable();

export const analyticsProviderSchema = z.enum([
  "google_search_console",
  "vercel_web_analytics",
  "google_analytics",
  "manual_csv",
  "manual_json",
  "publication_records",
  "social_manual",
  "future_provider",
]);
export type AnalyticsProviderName = z.infer<typeof analyticsProviderSchema>;

export const missingDataStateSchema = z.enum([
  "available",
  "not_available",
  "not_collected",
  "not_supported",
  "permission_denied",
]);
export const dataQualityLabelSchema = z.enum([
  "high",
  "moderate",
  "low",
  "insufficient",
]);
export const dataCompletenessSchema = z
  .object({
    label: dataQualityLabelSchema,
    score: z.number().min(0).max(1),
    providerCoverage: z.number().min(0).max(1),
    dateCoverage: z.number().min(0).max(1),
    mappingConfidence: z.number().min(0).max(1),
    metricStates: z.record(z.string(), missingDataStateSchema),
    stale: z.boolean(),
    partialWindow: z.boolean(),
    conflicts: z.array(z.string().max(300)),
    warnings: z.array(z.string().max(300)),
  })
  .strict();
export type DataCompleteness = z.infer<typeof dataCompletenessSchema>;

export const analyticsSourceSchema = z
  .object({
    id: opaque("analyticssource"),
    provider: analyticsProviderSchema,
    sourceType: z.enum(["api", "manual_import", "internal_records", "fixture"]),
    status: z.enum([
      "configured",
      "available",
      "unavailable",
      "authentication_required",
      "disabled",
      "error",
    ]),
    connectedAt: iso.nullable(),
    lastSyncedAt: iso.nullable(),
    capabilities: z.array(z.string().min(1).max(100)),
    configurationHash: hash,
    warnings: z.array(z.string().max(500)),
  })
  .strict();
export type AnalyticsSource = z.infer<typeof analyticsSourceSchema>;

export const analyticsSyncJobSchema = z
  .object({
    id: opaque("analyticssync"),
    provider: analyticsProviderSchema,
    scope: z.string().min(1).max(300),
    windowStart: iso,
    windowEnd: iso,
    status: z.enum([
      "pending",
      "running",
      "completed",
      "partial",
      "failed",
      "cancelled",
    ]),
    startedAt: iso,
    completedAt: iso.nullable(),
    failedAt: iso.nullable(),
    failureCode: z.string().max(100).nullable(),
    failureMessage: z.string().max(500).nullable(),
    recordsImported: z.number().int().nonnegative(),
    recordsSkipped: z.number().int().nonnegative(),
    checkpoint: z.string().max(500).nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.windowStart) < Date.parse(value.windowEnd),
    {
      message: "Analytics sync window must have positive duration",
    },
  );
export type AnalyticsSyncJob = z.infer<typeof analyticsSyncJobSchema>;

export const normalizedMetricSchema = z
  .object({
    provider: analyticsProviderSchema,
    originalMetric: z.string().min(1).max(100),
    normalizedCategory: z.enum([
      "exposure",
      "traffic",
      "engagement",
      "search",
      "distribution",
      "workflow",
    ]),
    value: z.number().nonnegative().nullable(),
    semantics: z.string().min(1).max(500),
    state: missingDataStateSchema,
  })
  .strict();

const breakdown = z
  .record(z.string().min(1), z.number().nonnegative())
  .nullable();
export const operationalMetricsSchema = z
  .object({
    articleType: z.string().max(100).nullable(),
    categories: z.array(z.string().max(100)),
    tags: z.array(z.string().max(100)),
    wordCount: nullableCount,
    readingMinutes: nullableNumber,
    sourceCount: nullableCount,
    researchConfidence: z.number().min(0).max(1).nullable(),
    originalTopicScore: z.number().min(0).max(100).nullable(),
    scoreComponents: z.record(z.string(), z.number()).nullable(),
    discoveryToApprovalSeconds: nullableNumber,
    approvalToPublicationSeconds: nullableNumber,
    editorialCycleSeconds: nullableNumber,
    reviewIterations: nullableCount,
    draftVersions: nullableCount,
    socialPackagesGenerated: nullableCount,
    platformsApproved: nullableCount,
    platformsPosted: nullableCount,
    distributionCompletionRate: nullableRate,
    failureCount: nullableCount,
    retryCount: nullableCount,
  })
  .strict();

export const articleMetricsSchema = z
  .object({
    id: opaque("articlemetric"),
    importId: opaque("analyticsimport"),
    publicationId: opaque("publication"),
    topicId: z.string().min(1),
    slug: z.string().min(1),
    canonicalUrl: z.string().url(),
    windowStart: iso,
    windowEnd: iso,
    impressions: nullableCount,
    clicks: nullableCount,
    sessions: nullableCount,
    pageViews: nullableCount,
    uniqueVisitors: nullableCount,
    engagedSessions: nullableCount,
    averageEngagementSeconds: nullableNumber,
    bounceRate: nullableRate,
    searchImpressions: nullableCount,
    searchClicks: nullableCount,
    searchCtr: nullableRate,
    averageSearchPosition: nullableNumber,
    referralTraffic: nullableCount,
    socialTraffic: nullableCount,
    directTraffic: nullableCount,
    sourceBreakdown: breakdown,
    deviceBreakdown: breakdown,
    countryBreakdown: breakdown,
    dataCompleteness: dataCompletenessSchema,
    providers: z.array(analyticsProviderSchema).min(1),
    normalizedMetrics: z.array(normalizedMetricSchema),
    operational: operationalMetricsSchema.nullable(),
    collectedAt: iso,
    contentHash: hash,
  })
  .strict()
  .refine(
    (value) => Date.parse(value.windowStart) < Date.parse(value.windowEnd),
    {
      message: "Article metric window must have positive duration",
    },
  );
export type ArticleMetrics = z.infer<typeof articleMetricsSchema>;

export const socialMetricsSchema = z
  .object({
    id: opaque("socialmetric"),
    importId: opaque("analyticsimport"),
    postedRecordId: z.string().min(1).max(200),
    publicationId: opaque("publication"),
    platform: socialPlatformSchema,
    postUrl: z.string().url(),
    windowStart: iso,
    windowEnd: iso,
    impressions: nullableCount,
    views: nullableCount,
    reach: nullableCount,
    likes: nullableCount,
    reactions: nullableCount,
    comments: nullableCount,
    shares: nullableCount,
    reposts: nullableCount,
    saves: nullableCount,
    clicks: nullableCount,
    profileVisits: nullableCount,
    engagementRate: nullableRate,
    videoWatchTime: nullableNumber,
    dataCompleteness: dataCompletenessSchema,
    collectionMethod: z.enum([
      "manual_csv",
      "manual_json",
      "provider_api",
      "fixture",
    ]),
    normalizedMetrics: z.array(normalizedMetricSchema),
    collectedAt: iso,
    contentHash: hash,
  })
  .strict()
  .refine(
    (value) => Date.parse(value.windowStart) < Date.parse(value.windowEnd),
    {
      message: "Social metric window must have positive duration",
    },
  );
export type SocialMetrics = z.infer<typeof socialMetricsSchema>;

export const derivedMetricsSchema = z
  .object({
    searchCtr: nullableRate,
    socialClickThroughRate: nullableRate,
    engagementRate: nullableRate,
    viewsPerDay: nullableNumber,
    clicksPerDay: nullableNumber,
    impressionsPerDay: nullableNumber,
    searchGrowthRate: z.number().nullable(),
    trafficSourceConcentration: nullableRate,
    socialToSiteClickRatio: nullableNumber,
    publicationVelocity: nullableNumber,
    editorialCycleSeconds: nullableNumber,
    revisionCount: nullableCount,
    sourceDiversity: nullableCount,
    searchLongevity: nullableNumber,
    distributionCompletionRate: nullableRate,
    performanceIndex: z
      .object({
        score: z.number().min(0).max(100),
        componentsUsed: z.array(z.string()),
        componentsOmitted: z.array(z.string()),
        baseline: z.string(),
        confidence: z.enum(["high", "moderate", "low", "insufficient"]),
      })
      .nullable(),
  })
  .strict();

export const performancePeriodSchema = z.enum([
  "24h",
  "7d",
  "28d",
  "90d",
  "lifetime",
]);
export const performanceSnapshotSchema = z
  .object({
    id: opaque("snapshot"),
    publicationId: opaque("publication"),
    period: performancePeriodSchema,
    articleMetrics: z.array(articleMetricsSchema),
    socialMetrics: z.array(socialMetricsSchema),
    derivedMetrics: derivedMetricsSchema,
    createdAt: iso,
    contentHash: hash,
    warnings: z.array(z.string().max(500)),
  })
  .strict();
export type PerformanceSnapshot = z.infer<typeof performanceSnapshotSchema>;

export const experimentRecommendationSchema = z
  .object({
    hypothesis: z.string().min(1).max(1000),
    metric: z.string().min(1).max(100),
    baseline: z.string().min(1).max(500),
    duration: z.string().min(1).max(200),
    minimumSampleSize: z.number().int().positive(),
    variablesHeldConstant: z.array(z.string().min(1).max(300)).min(1),
    stopCondition: z.string().min(1).max(500),
    ethicalConstraints: z.array(z.string().min(1).max(300)).min(1),
    status: z.literal("requires_manual_review"),
  })
  .strict();

export const editorialInsightSchema = z
  .object({
    id: opaque("insight"),
    category: z.enum([
      "topic_performance",
      "article_type",
      "headline",
      "search",
      "social_platform",
      "publishing_time",
      "shelf_life",
      "source_mix",
      "content_length",
      "category_mix",
      "engagement",
      "distribution",
      "conversion",
      "data_quality",
      "workflow_efficiency",
      "ranking_feedback",
    ]),
    scope: z.string().min(1).max(300),
    title: z.string().min(1).max(200),
    observation: z.string().min(1).max(1500),
    evidence: z.array(z.string().min(1).max(500)),
    confidence: z.enum(["high", "moderate", "low", "insufficient"]),
    sampleSize: z.number().int().nonnegative(),
    recommendedAction: z.string().min(1).max(1000),
    limitations: z.array(z.string().min(1).max(500)).min(1),
    status: z.enum([
      "informational",
      "review_recommended",
      "action_recommended",
      "insufficient_data",
    ]),
    dataQuality: dataQualityLabelSchema,
    suggestedChange: z
      .object({
        field: z.string(),
        current: z.number(),
        proposed: z.number(),
        status: z.literal("requires_manual_review"),
      })
      .strict()
      .nullable(),
    experiment: experimentRecommendationSchema.nullable(),
    createdAt: iso,
    version: z.number().int().positive(),
  })
  .strict();
export type EditorialInsight = z.infer<typeof editorialInsightSchema>;

const reportEntry = z.object({
  publicationId: opaque("publication"),
  title: z.string(),
  metric: z.string(),
  value: z.number().nullable(),
  dataQuality: dataQualityLabelSchema,
});
export const editorialReportSchema = z
  .object({
    id: opaque("report"),
    reportType: z.enum(["weekly", "monthly", "quarterly", "custom"]),
    periodStart: iso,
    periodEnd: iso,
    publicationCount: z.number().int().nonnegative(),
    socialPostCount: z.number().int().nonnegative(),
    dataCoverage: dataCompletenessSchema,
    topPerformers: z.array(reportEntry),
    underperformers: z.array(reportEntry),
    searchHighlights: z.array(z.string().max(1000)),
    socialHighlights: z.array(z.string().max(1000)),
    topicInsights: z.array(z.string().max(1000)),
    articleTypeInsights: z.array(z.string().max(1000)),
    distributionInsights: z.array(z.string().max(1000)),
    timingInsights: z.array(z.string().max(1000)),
    contentLengthInsights: z.array(z.string().max(1000)),
    workflowInsights: z.array(z.string().max(1000)),
    rankingFeedback: z.array(z.string().max(1000)),
    recommendations: z.array(z.string().max(1000)),
    experiments: z.array(experimentRecommendationSchema),
    dataLimitations: z.array(z.string().min(1).max(1000)).min(1),
    generatedAt: iso,
    contentHash: hash,
    version: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.periodStart) < Date.parse(value.periodEnd),
    {
      message: "Editorial report window must have positive duration",
    },
  );
export type EditorialReport = z.infer<typeof editorialReportSchema>;

export const analyticsImportSchema = z
  .object({
    id: opaque("analyticsimport"),
    provider: analyticsProviderSchema,
    fileHash: hash,
    importedAt: iso,
    fileName: z.string().min(1).max(300),
    byteCount: z.number().int().positive(),
    rowCount: z.number().int().nonnegative(),
    articleRecordCount: z.number().int().nonnegative(),
    socialRecordCount: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(500)),
  })
  .strict();
export type AnalyticsImport = z.infer<typeof analyticsImportSchema>;

export const assistedAnalysisSchema = z
  .object({
    reportId: opaque("report"),
    reportContentHash: hash,
    taskHash: hash,
    observations: z.array(
      z
        .object({
          title: z.string().min(1).max(200),
          metricIds: z.array(z.string().min(1)).min(1),
          publicationIds: z.array(opaque("publication")),
          period: z.string().min(1).max(100),
          sampleSize: z.number().int().nonnegative(),
          confidence: z.enum(["high", "moderate", "low", "insufficient"]),
          interpretation: z.string().min(1).max(1500),
          alternativeExplanations: z.array(z.string().min(1).max(500)).min(1),
          recommendation: z.string().min(1).max(1000),
        })
        .strict(),
    ),
    unresolvedQuestions: z.array(z.string().max(500)),
    status: z.literal("advisory_only"),
  })
  .strict();
export type AssistedAnalysis = z.infer<typeof assistedAnalysisSchema>;

export const insightActionSchema = z
  .object({
    insightId: opaque("insight"),
    action: z.enum([
      "reviewed",
      "accepted_for_consideration",
      "dismissed",
      "note_added",
    ]),
    note: z.string().max(1000).nullable(),
    createdAt: iso,
    version: z.number().int().positive(),
  })
  .strict();
export type InsightAction = z.infer<typeof insightActionSchema>;
