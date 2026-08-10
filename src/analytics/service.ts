import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ProductionPublicationArtifact } from "../publication/models";
import type { PostedRecord } from "../social/models";
import { sha256 } from "../writing/task";
import type { AnalyticsConfig } from "./config";
import {
  buildInsights,
  dataQuality,
  deriveMetrics,
  median,
} from "./calculations";
import type {
  AnalyticsImportRepository,
  AnalyticsProvider,
  AnalyticsSourceRepository,
  AnalyticsSyncJobRepository,
  AnalyticsTaskRepository,
  ArticleMetricsRepository,
  EditorialInsightRepository,
  EditorialReportRepository,
  PerformanceSnapshotRepository,
  SocialMetricsRepository,
} from "./interfaces";
import { normalizeImport } from "./importer";
import {
  analyticsImportSchema,
  analyticsProviderSchema,
  analyticsSourceSchema,
  analyticsSyncJobSchema,
  articleMetricsSchema,
  assistedAnalysisSchema,
  editorialReportSchema,
  insightActionSchema,
  performancePeriodSchema,
  performanceSnapshotSchema,
  type EditorialReport,
  type PerformanceSnapshot,
} from "./models";
import { scrubAnalytics } from "./privacy";

export interface AnalyticsDependencies {
  sources: AnalyticsSourceRepository;
  syncJobs: AnalyticsSyncJobRepository;
  articleMetrics: ArticleMetricsRepository;
  socialMetrics: SocialMetricsRepository;
  snapshots: PerformanceSnapshotRepository;
  insights: EditorialInsightRepository;
  reports: EditorialReportRepository;
  imports: AnalyticsImportRepository;
  tasks: AnalyticsTaskRepository;
  publications: { list(): Promise<ProductionPublicationArtifact[]> };
  postedRecords: { list(): Promise<PostedRecord[]> };
  providers?: AnalyticsProvider[];
  config: AnalyticsConfig;
  clock?: () => Date;
}

export class AnalyticsService {
  constructor(private d: AnalyticsDependencies) {}
  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }

  async status() {
    return {
      sources: await this.d.sources.list(),
      imports: (await this.d.imports.list()).length,
      articleMetricRecords: (await this.d.articleMetrics.list()).length,
      socialMetricRecords: (await this.d.socialMetrics.list()).length,
      snapshots: (await this.d.snapshots.list()).length,
      insights: (await this.d.insights.list()).length,
      reports: (await this.d.reports.list()).length,
      strategyMutationEnabled: false,
      dashboardEnabled: false,
    };
  }

  async configureSources(configurationText: string) {
    const configurationHash = sha256(configurationText),
      now = this.now().toISOString();
    for (const provider of this.d.config.enabledProviders) {
      const adapter = this.d.providers?.find(
        (value) => value.provider === provider,
      );
      const capabilities = adapter
        ? await adapter.getCapabilities()
        : undefined;
      await this.d.sources.save(
        analyticsSourceSchema.parse({
          id: `analyticssource_${sha256(provider).slice(0, 24)}`,
          provider,
          sourceType:
            provider === "publication_records"
              ? "internal_records"
              : provider.startsWith("manual_") || provider === "social_manual"
                ? "manual_import"
                : "api",
          status:
            provider === "publication_records" ||
            provider.startsWith("manual_") ||
            provider === "social_manual"
              ? "available"
              : capabilities?.liveAccess
                ? "configured"
                : "authentication_required",
          connectedAt: provider === "publication_records" ? now : null,
          lastSyncedAt: null,
          capabilities:
            capabilities?.metrics ??
            (provider === "publication_records"
              ? ["publishing", "workflow", "distribution"]
              : []),
          configurationHash,
          warnings:
            capabilities?.liveAccess === false
              ? [
                  "No live read adapter is configured; use aggregate manual import.",
                ]
              : [],
        }),
      );
    }
  }

  async importFile(providerRaw: string, path: string) {
    const provider = analyticsProviderSchema.parse(providerRaw);
    if (!this.d.config.enabledProviders.includes(provider))
      throw new Error("Analytics provider is disabled");
    const body = await readFile(path, "utf8");
    const normalized = normalizeImport({
      body,
      fileName: path,
      provider,
      publications: await this.d.publications.list(),
      posts: await this.d.postedRecords.list(),
      config: this.d.config,
      now: this.now().toISOString(),
    });
    const duplicate = await this.d.imports.findByHash(normalized.reusedHash);
    if (duplicate)
      return {
        importId: duplicate.id,
        reused: true,
        articleRecords: duplicate.articleRecordCount,
        socialRecords: duplicate.socialRecordCount,
      };
    await this.d.articleMetrics.saveMany(normalized.articles);
    await this.d.socialMetrics.saveMany(normalized.social);
    await this.d.imports.save(normalized.metadata);
    return {
      importId: normalized.metadata.id,
      reused: false,
      articleRecords: normalized.articles.length,
      socialRecords: normalized.social.length,
    };
  }

  async sync(providerRaw = "publication_records", from?: string, to?: string) {
    const provider = analyticsProviderSchema.parse(providerRaw);
    const now = this.now(),
      start = from
        ? day(from)
        : new Date(now.valueOf() - 28 * 86_400_000).toISOString(),
      end = to ? day(to, true) : now.toISOString();
    if (Date.parse(start) >= Date.parse(end))
      throw new Error("Analytics sync range is invalid");
    const id = `analyticssync_${sha256(`${provider}:${start}:${end}`).slice(0, 24)}`;
    const existing = await this.d.syncJobs.get(id);
    if (existing?.status === "completed")
      return { job: existing, reused: true };
    await this.d.syncJobs.save(
      analyticsSyncJobSchema.parse({
        id,
        provider,
        scope: "published_articles",
        windowStart: start,
        windowEnd: end,
        status: "running",
        startedAt: now.toISOString(),
        completedAt: null,
        failedAt: null,
        failureCode: null,
        failureMessage: null,
        recordsImported: 0,
        recordsSkipped: 0,
        checkpoint: null,
        version: existing ? existing.version + 1 : 1,
      }),
    );
    if (provider !== "publication_records") {
      const adapter = this.d.providers?.find(
        (value) => value.provider === provider,
      );
      if (!adapter)
        throw new Error(
          `${provider} live collection is unavailable; use manual aggregate import`,
        );
      throw new Error(
        `${provider} collection requires explicitly configured credentials and is not enabled by the local CLI`,
      );
    }
    const publications = (await this.d.publications.list()).filter(
      (value) => value.status === "published" && value.publishedAt < end,
    );
    const posts = await this.d.postedRecords.list(),
      importHash = sha256(
        JSON.stringify(
          publications.map((value) => [
            value.id,
            value.contentHash,
            value.updatedAt,
          ]),
        ),
      ),
      importId = `analyticsimport_${importHash.slice(0, 24)}`;
    const duplicate = await this.d.imports.findByHash(importHash);
    if (!duplicate) {
      const metrics = publications.map((publication) => {
        const publicationPosts = posts.filter(
            (post) => post.publicationId === publication.id,
          ),
          totalPlatforms = 4;
        const contentHash = sha256(
          JSON.stringify({
            publicationId: publication.id,
            start,
            end,
            publicationHash: publication.contentHash,
            posts: publicationPosts.map((post) => post.contentHash),
          }),
        );
        return articleMetricsSchema.parse({
          id: `articlemetric_${contentHash.slice(0, 24)}`,
          importId,
          publicationId: publication.id,
          topicId: publication.topicId,
          slug: publication.slug,
          canonicalUrl: publication.canonicalUrl,
          windowStart: start,
          windowEnd: end,
          impressions: null,
          clicks: null,
          sessions: null,
          pageViews: null,
          uniqueVisitors: null,
          engagedSessions: null,
          averageEngagementSeconds: null,
          bounceRate: null,
          searchImpressions: null,
          searchClicks: null,
          searchCtr: null,
          averageSearchPosition: null,
          referralTraffic: null,
          socialTraffic: null,
          directTraffic: null,
          sourceBreakdown: null,
          deviceBreakdown: null,
          countryBreakdown: null,
          dataCompleteness: dataQuality({
            available: 4,
            total: 18,
            providerCoverage: 0.25,
            dateCoverage: 1,
            mappingConfidence: 1,
            config: this.d.config,
          }),
          providers: ["publication_records"],
          normalizedMetrics: [],
          operational: {
            articleType: null,
            categories: [],
            tags: [],
            wordCount: null,
            readingMinutes: null,
            sourceCount: publication.sourceCount,
            researchConfidence: null,
            originalTopicScore: null,
            scoreComponents: null,
            discoveryToApprovalSeconds: null,
            approvalToPublicationSeconds: Math.max(
              0,
              (Date.parse(publication.publishedAt) -
                Date.parse(publication.createdAt)) /
                1000,
            ),
            editorialCycleSeconds: null,
            reviewIterations: publication.reviewVersion,
            draftVersions: publication.draftVersion,
            socialPackagesGenerated: null,
            platformsApproved: null,
            platformsPosted: publicationPosts.length,
            distributionCompletionRate:
              publicationPosts.length / totalPlatforms,
            failureCount: 0,
            retryCount: Math.max(0, publication.version - 1),
          },
          collectedAt: now.toISOString(),
          contentHash,
        });
      });
      await this.d.articleMetrics.saveMany(metrics);
      await this.d.imports.save(
        analyticsImportSchema.parse({
          id: importId,
          provider,
          fileHash: importHash,
          importedAt: now.toISOString(),
          fileName: "publication-records",
          byteCount: Buffer.byteLength(JSON.stringify(publications)),
          rowCount: metrics.length,
          articleRecordCount: metrics.length,
          socialRecordCount: 0,
          warnings: [
            "Traffic fields remain null until an aggregate traffic provider is imported.",
          ],
        }),
      );
    }
    const completed = analyticsSyncJobSchema.parse({
      id,
      provider,
      scope: "published_articles",
      windowStart: start,
      windowEnd: end,
      status: "completed",
      startedAt: existing?.startedAt ?? now.toISOString(),
      completedAt: now.toISOString(),
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      recordsImported: publications.length,
      recordsSkipped: duplicate ? publications.length : 0,
      checkpoint: publications.at(-1)?.id ?? null,
      version: existing ? existing.version + 2 : 2,
    });
    await this.d.syncJobs.save(completed);
    return { job: completed, reused: Boolean(duplicate) };
  }

  async article(publicationId: string) {
    return this.d.articleMetrics.list(publicationId);
  }
  async social(publicationId: string) {
    return this.d.socialMetrics.list(publicationId);
  }

  async snapshot(publicationId: string, periodRaw: string) {
    const period = performancePeriodSchema.parse(periodRaw),
      existing = await this.d.snapshots.get(publicationId, period);
    if (existing) return { snapshot: existing, reused: true };
    const publication = (await this.d.publications.list()).find(
      (value) => value.id === publicationId && value.status === "published",
    );
    if (!publication)
      throw new Error("Exact published publication ID not found");
    const now = this.now(),
      days = periodDays(period),
      maximumEnd =
        days === null
          ? now
          : new Date(Date.parse(publication.publishedAt) + days * 86_400_000),
      end = maximumEnd < now ? maximumEnd : now;
    const article = (await this.d.articleMetrics.list(publicationId)).filter(
      (value) =>
        Date.parse(value.windowStart) < end.valueOf() &&
        Date.parse(value.windowEnd) > Date.parse(publication.publishedAt),
    );
    const social = (await this.d.socialMetrics.list(publicationId)).filter(
      (value) => Date.parse(value.windowStart) < end.valueOf(),
    );
    const partial =
      days !== null &&
      now.valueOf() < Date.parse(publication.publishedAt) + days * 86_400_000;
    const content = {
      publicationId,
      period,
      articleHashes: article.map((value) => value.contentHash),
      socialHashes: social.map((value) => value.contentHash),
      partial,
    };
    const contentHash = sha256(JSON.stringify(content));
    const snapshot = performanceSnapshotSchema.parse({
      id: `snapshot_${contentHash.slice(0, 24)}`,
      publicationId,
      period,
      articleMetrics: article,
      socialMetrics: social,
      derivedMetrics: deriveMetrics(article, social, days),
      createdAt: now.toISOString(),
      contentHash,
      warnings: [
        ...(partial
          ? [
              "Performance window is incomplete; exclude it from complete-window baselines.",
            ]
          : []),
        ...(!article.length
          ? ["No article traffic metrics are available."]
          : []),
      ],
    });
    await this.d.snapshots.save(snapshot);
    return { snapshot, reused: false };
  }

  async generateInsights() {
    const values = buildInsights(
      await this.d.snapshots.list(),
      this.d.config,
      this.now().toISOString(),
    );
    await this.d.insights.saveMany(values);
    return values;
  }

  async report(
    type: "weekly" | "monthly" | "custom",
    from?: string,
    to?: string,
  ) {
    const now = this.now(),
      end = to ? new Date(day(to, true)) : now,
      duration = type === "weekly" ? 7 : type === "monthly" ? 28 : 7,
      start = from
        ? new Date(day(from))
        : new Date(end.valueOf() - duration * 86_400_000);
    if (start >= end) throw new Error("Report range is invalid");
    const publications = (await this.d.publications.list()).filter(
      (value) =>
        value.status === "published" &&
        Date.parse(value.publishedAt) >= start.valueOf() &&
        Date.parse(value.publishedAt) < end.valueOf(),
    );
    const allSnapshots = await this.d.snapshots.list(),
      snapshots = allSnapshots.filter((value) =>
        publications.some(
          (publication) => publication.id === value.publicationId,
        ),
      );
    const insights = await this.generateInsights(),
      posts = (await this.d.postedRecords.list()).filter(
        (value) =>
          Date.parse(value.postedAt) >= start.valueOf() &&
          Date.parse(value.postedAt) < end.valueOf(),
      );
    const entries = snapshots.map((snapshot) => {
      const publication = publications.find(
        (value) => value.id === snapshot.publicationId,
      )!;
      return {
        publicationId: publication.id,
        title: publication.title,
        metric: "performance_index",
        value: snapshot.derivedMetrics.performanceIndex?.score ?? null,
        dataQuality:
          snapshot.articleMetrics[0]?.dataCompleteness.label ??
          ("insufficient" as const),
      };
    });
    const sorted = [...entries]
      .filter((value) => value.value !== null)
      .sort((a, b) => b.value! - a.value!);
    const coverage = dataQuality({
      available: snapshots.filter((value) => value.articleMetrics.length)
        .length,
      total: Math.max(1, publications.length),
      providerCoverage: (await this.d.sources.list()).some(
        (value) =>
          value.provider === "google_search_console" &&
          value.status === "available",
      )
        ? 0.75
        : 0.25,
      dateCoverage: publications.length
        ? new Set(snapshots.map((value) => value.publicationId)).size /
          publications.length
        : 0,
      mappingConfidence: 1,
      config: this.d.config,
    });
    const experiments = insights.flatMap((value) =>
      value.experiment ? [value.experiment] : [],
    );
    const base = {
      reportType: type,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      publicationCount: publications.length,
      socialPostCount: posts.length,
      dataCoverage: coverage,
      topPerformers: sorted.slice(0, 3),
      underperformers: sorted.slice(-3).reverse(),
      searchHighlights: snapshots.some(
        (value) => value.derivedMetrics.searchCtr !== null,
      )
        ? [
            `Median available search CTR: ${((median(snapshots.map((value) => value.derivedMetrics.searchCtr)) ?? 0) * 100).toFixed(1)}%`,
          ]
        : [
            "Search data is unavailable; no zero-performance inference was made.",
          ],
      socialHighlights: [
        `${posts.length} manually confirmed social post(s) fall in this reporting range.`,
      ],
      topicInsights: insights
        .filter((value) => value.category === "topic_performance")
        .map((value) => value.observation),
      articleTypeInsights: insights
        .filter((value) => value.category === "article_type")
        .map((value) => value.observation),
      distributionInsights: [
        "Distribution completion is operational and is not treated as a content-quality score.",
      ],
      timingInsights: [
        "No timing recommendation is generated without the configured minimum comparable sample.",
      ],
      contentLengthInsights: [
        "No length recommendation is generated from traffic alone.",
      ],
      workflowInsights: [
        "Workflow durations are reported only when exact stage timestamps are available.",
      ],
      rankingFeedback: [
        "Ranking configuration was read-only. Any weight suggestion requires a separate human-controlled workflow.",
      ],
      recommendations: insights.map((value) => value.recommendedAction),
      experiments,
      dataLimitations: [
        ...new Set([
          "Missing metrics remain null and are not interpreted as zero.",
          ...insights.flatMap((value) => value.limitations),
          coverage.label === "high"
            ? "Provider semantics remain non-equivalent across platforms."
            : "Provider coverage is incomplete.",
        ]),
      ],
      generatedAt: now.toISOString(),
      version: 1,
    };
    const contentHash = sha256(JSON.stringify(base)),
      id = `report_${sha256(`${type}:${start.toISOString()}:${end.toISOString()}`).slice(0, 24)}`;
    const report = editorialReportSchema.parse({ id, ...base, contentHash });
    const files = reportFiles(report, snapshots);
    const created = await this.d.reports.save(report, files);
    return {
      report: created ? report : (await this.d.reports.get(id))!,
      reused: !created,
    };
  }

  async prepareAnalysis(reportId: string) {
    const report = await this.d.reports.get(reportId);
    if (!report) throw new Error("Editorial report not found");
    const input = {
      reportId: report.id,
      contentHash: report.contentHash,
      period: [report.periodStart, report.periodEnd],
      aggregates: {
        publicationCount: report.publicationCount,
        socialPostCount: report.socialPostCount,
        coverage: report.dataCoverage,
        topPerformers: report.topPerformers,
        searchHighlights: report.searchHighlights,
        socialHighlights: report.socialHighlights,
      },
      deterministicInsights: [
        ...report.topicInsights,
        ...report.articleTypeInsights,
        ...report.workflowInsights,
      ],
      limitations: report.dataLimitations,
      allowedMetricIds: [
        "search_ctr",
        "performance_index",
        "distribution_completion",
        "editorial_cycle_time",
      ],
    };
    const serialized = JSON.stringify(input);
    if (
      Buffer.byteLength(serialized) > this.d.config.assistedAnalysisPacketBytes
    )
      throw new Error("Analytics analysis packet exceeds configured limit");
    scrubAnalytics(serialized);
    const taskHash = sha256(serialized);
    const path = await this.d.tasks.write(reportId, {
      "analytics-analysis.md": `# Advisory analytics analysis\n\nUse only analytics-input.json. Do not browse. Preserve sample sizes and uncertainty. Identify alternative explanations. Do not make causal claims, modify configuration, publish, post, or activate experiments. Return JSON matching expected-output.schema.json only.\n\nTask hash: ${taskHash}\n`,
      "analytics-input.json": `${JSON.stringify(input, null, 2)}\n`,
      "expected-output.schema.json": `${JSON.stringify(z.toJSONSchema(assistedAnalysisSchema), null, 2)}\n`,
    });
    return { reportId, taskHash, taskDirectory: path };
  }

  async importAnalysis(reportId: string, path: string) {
    const report = await this.d.reports.get(reportId);
    if (!report) throw new Error("Editorial report not found");
    const raw = await readFile(path, "utf8");
    scrubAnalytics(raw);
    const value = assistedAnalysisSchema.parse(JSON.parse(raw));
    if (
      value.reportId !== report.id ||
      value.reportContentHash !== report.contentHash
    )
      throw new Error("Assisted analysis does not match exact report");
    const knownPublications = new Set(
      (await this.d.publications.list()).map((publication) => publication.id),
    );
    const allowedMetrics = new Set([
      "search_ctr",
      "performance_index",
      "distribution_completion",
      "editorial_cycle_time",
    ]);
    for (const observation of value.observations) {
      if (observation.metricIds.some((metric) => !allowedMetrics.has(metric)))
        throw new Error("Assisted analysis invented an unknown metric");
      if (observation.publicationIds.some((id) => !knownPublications.has(id)))
        throw new Error("Assisted analysis references an unknown publication");
      if (
        /\b(?:caused|proves?|guarantees?|always|definitively)\b/i.test(
          observation.interpretation,
        )
      )
        throw new Error("Unsupported causal claim in assisted analysis");
    }
    await this.d.tasks.saveAnalysis(reportId, value);
    return {
      reportId,
      status: "advisory_only",
      observations: value.observations.length,
    };
  }

  async cleanup(dryRun: boolean, confirm = false) {
    if (!dryRun && !confirm)
      throw new Error("Destructive cleanup requires --confirm-cleanup yes");
    const cutoff = new Date(
      this.now().valueOf() -
        this.d.config.retention.importMetadataDays * 86_400_000,
    ).toISOString();
    return {
      cutoff,
      dryRun,
      candidates: await this.d.imports.removeOlderThan(cutoff, dryRun),
    };
  }

  async actOnInsight(
    insightId: string,
    action:
      "reviewed" | "accepted_for_consideration" | "dismissed" | "note_added",
    note?: string,
  ) {
    const insight = (await this.d.insights.list()).find(
      (value) => value.id === insightId,
    );
    if (!insight) throw new Error("Editorial insight not found");
    if (note) scrubAnalytics(note);
    const existing = await this.d.insights.actions(insightId);
    const value = insightActionSchema.parse({
      insightId,
      action,
      note: note ?? null,
      createdAt: this.now().toISOString(),
      version: existing.length + 1,
    });
    await this.d.insights.action(value);
    return { insightId, action, configurationChanged: false };
  }

  reports() {
    return this.d.reports.list();
  }
  insights() {
    return this.d.insights.list();
  }
}

function day(value: string, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Date must use YYYY-MM-DD");
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid date");
  return date.toISOString();
}
function periodDays(period: z.infer<typeof performancePeriodSchema>) {
  return { "24h": 1, "7d": 7, "28d": 28, "90d": 90, lifetime: null }[period];
}
function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
function reportFiles(
  report: EditorialReport,
  snapshots: PerformanceSnapshot[],
) {
  const markdown = `# ${report.reportType[0]!.toUpperCase()}${report.reportType.slice(1)} editorial report\n\nPeriod: ${report.periodStart} to ${report.periodEnd}\n\nPublished articles: ${report.publicationCount}\n\nManually confirmed social posts: ${report.socialPostCount}\n\nData quality: ${report.dataCoverage.label}\n\n## Recommendations\n\n${report.recommendations.map((value) => `- ${value}`).join("\n") || "- No recommendation met the configured evidence threshold."}\n\n## Limitations\n\n${report.dataLimitations.map((value) => `- ${value}`).join("\n")}\n\nRecommendations require manual review and do not modify configuration.\n`;
  const articleRows = [
    "publication_id,period,search_ctr,views_per_day,performance_index",
    ...snapshots.map((value) =>
      [
        value.publicationId,
        value.period,
        value.derivedMetrics.searchCtr,
        value.derivedMetrics.viewsPerDay,
        value.derivedMetrics.performanceIndex?.score,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
  const socialRows = [
    "publication_id,period,platform,impressions,clicks,engagement_rate",
    ...snapshots.flatMap((snapshot) =>
      snapshot.socialMetrics.map((value) =>
        [
          snapshot.publicationId,
          snapshot.period,
          value.platform,
          value.impressions,
          value.clicks,
          value.engagementRate,
        ]
          .map(csvCell)
          .join(","),
      ),
    ),
  ].join("\n");
  for (const body of [markdown, articleRows, socialRows]) scrubAnalytics(body);
  return {
    "report.md": markdown,
    "article-metrics.csv": `${articleRows}\n`,
    "social-metrics.csv": `${socialRows}\n`,
  };
}
