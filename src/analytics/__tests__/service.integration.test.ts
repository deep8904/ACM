import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  publicationRecordSchema,
  type ProductionPublicationArtifact,
} from "../../publication/models";
import { productionArtifactFixture } from "../../publication/__tests__/production-artifact-fixture";
import { postedRecordSchema, type PostedRecord } from "../../social/models";
import { analyticsConfigSchema } from "../config";
import { AnalyticsService } from "../service";
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
} from "../storage";

const roots: string[] = [],
  hash = "a".repeat(64),
  clock = () => new Date("2026-06-29T00:00:00.000Z");
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function publication(index: number): ProductionPublicationArtifact {
  const id = String(index).repeat(24),
    publishedAt =
      index === 5
        ? "2026-06-27T00:00:00.000Z"
        : `2026-06-0${index}T00:00:00.000Z`;
  return productionArtifactFixture(
    publicationRecordSchema.parse({
      id: `publication_${id}`,
      topicId: `topic-${index}`,
      draftId: `draft_${id}`,
      draftVersion: 1,
      reviewId: `review_${id}`,
      reviewVersion: index,
      researchPacketId: `packet_${id}`,
      researchPacketVersion: 1,
      finalApprovedEventId: `articleevent_${id}`,
      status: "published",
      title: [
        "Technical explainer",
        "Breaking news",
        "Long-tail buying guide",
        "Game analysis",
        "New partial article",
      ][index - 1],
      slug: `article-${index}`,
      articlePath: `content/article-${index}.mdx`,
      repository: "fixture/blog",
      branch: "main",
      commitSha: hash,
      deploymentProvider: "mock",
      canonicalUrl: `https://deep.example/article-${index}`,
      publishedAt,
      sourceCount: 4,
      contentHash: hash,
      approvedSnapshotHash: hash,
      publishedSnapshotHash: hash,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: publishedAt,
      warnings: [],
      provenance: { mode: "fixture", parentSha: hash },
      version: index,
    }),
  );
}
function post(
  index: number,
  platform: "linkedin" | "x" | "instagram",
  url: string,
  letter: string,
): PostedRecord {
  const id = String(index).repeat(24);
  return postedRecordSchema.parse({
    publicationId: `publication_${id}`,
    packageId: `socialpackage_${id}`,
    packageVersion: 1,
    platform,
    platformItemId: `socialitem_${id}`,
    postUrl: url,
    postedAt: "2026-06-10T00:00:00.000Z",
    method: "manual",
    contentHash: letter.repeat(64),
    verificationState: "operator_confirmed",
  });
}

describe("Milestone 9 offline integration and final audit", () => {
  it("runs import through advisory report without mutating earlier artifacts or creating outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "analytics-integration-"));
    roots.push(root);
    const analyticsRoot = join(root, "analytics"),
      taskRoot = join(root, "tasks"),
      publications = [1, 2, 3, 4, 5].map(publication);
    const posts = [
      post(1, "linkedin", "https://linkedin.com/posts/example-1", "a"),
      post(2, "x", "https://x.com/deep/status/100", "b"),
      post(3, "instagram", "https://instagram.com/p/example3", "c"),
    ];
    const configText = await readFile(
        "automation/config/analytics.example.yaml",
        "utf8",
      ),
      config = analyticsConfigSchema.parse(parse(configText));
    const rankingBefore = await readFile(
        "automation/config/ranking.example.yaml",
        "utf8",
      ),
      planBefore = await readFile("docs/03_IMPLEMENTATION_PLAN.md", "utf8");
    const service = new AnalyticsService({
      sources: new FileAnalyticsSourceRepository(analyticsRoot),
      syncJobs: new FileAnalyticsSyncJobRepository(analyticsRoot),
      articleMetrics: new FileArticleMetricsRepository(analyticsRoot),
      socialMetrics: new FileSocialMetricsRepository(analyticsRoot),
      snapshots: new FilePerformanceSnapshotRepository(analyticsRoot),
      insights: new FileEditorialInsightRepository(analyticsRoot),
      reports: new FileEditorialReportRepository(analyticsRoot),
      imports: new FileAnalyticsImportRepository(analyticsRoot),
      tasks: new FileAnalyticsTaskRepository(taskRoot),
      publications: { list: async () => publications },
      postedRecords: { list: async () => posts },
      config,
      clock,
    });
    await service.configureSources(configText);
    const articleFile = join(root, "articles.csv"),
      socialFile = join(root, "social.json");
    await writeFile(
      articleFile,
      await readFile("tests/fixtures/analytics/article-metrics.csv", "utf8"),
    );
    await writeFile(
      socialFile,
      await readFile("tests/fixtures/analytics/social-metrics.json", "utf8"),
    );
    const first = await service.importFile("manual_csv", articleFile),
      replay = await service.importFile("manual_csv", articleFile);
    expect(first.reused).toBe(false);
    expect(replay).toMatchObject({ reused: true, importId: first.importId });
    expect(
      (await service.importFile("social_manual", socialFile)).socialRecords,
    ).toBe(3);
    for (const item of publications) {
      await service.snapshot(item.id, "7d");
      await service.snapshot(item.id, "28d");
    }
    expect((await service.snapshot(publications[0]!.id, "7d")).reused).toBe(
      true,
    );
    const insights = await service.generateInsights();
    expect(insights.length).toBeGreaterThan(0);
    const weekly = await service.report("weekly"),
      weeklyReplay = await service.report("weekly"),
      monthly = await service.report("monthly");
    expect(weeklyReplay).toMatchObject({ reused: true });
    expect(monthly.report.reportType).toBe("monthly");
    expect(weekly.report.dataLimitations.join(" ")).toMatch(
      /null|coverage|provider/i,
    );
    const task = await service.prepareAnalysis(monthly.report.id),
      analysisFile = join(root, "advisory.json");
    await writeFile(
      analysisFile,
      JSON.stringify({
        reportId: monthly.report.id,
        reportContentHash: monthly.report.contentHash,
        taskHash: task.taskHash,
        observations: [
          {
            title: "Review search CTR",
            metricIds: ["search_ctr"],
            publicationIds: [publications[0]!.id],
            period: "28d",
            sampleSize: 5,
            confidence: "moderate",
            interpretation:
              "The aggregate is associated with stronger CTR in this fixture.",
            alternativeExplanations: ["Topic demand may differ."],
            recommendation: "Consider a manually reviewed headline experiment.",
          },
        ],
        unresolvedQuestions: ["Is the pattern stable next month?"],
        status: "advisory_only",
      }),
    );
    expect(
      await service.importAnalysis(monthly.report.id, analysisFile),
    ).toMatchObject({ status: "advisory_only" });
    await service.actOnInsight(insights[0]!.id, "accepted_for_consideration");
    expect((await service.status()).strategyMutationEnabled).toBe(false);
    expect(
      await readFile("automation/config/ranking.example.yaml", "utf8"),
    ).toBe(rankingBefore);
    expect(await readFile("docs/03_IMPLEMENTATION_PLAN.md", "utf8")).toBe(
      planBefore,
    );
    expect(publications).toHaveLength(5);
    expect(posts).toHaveLength(3);
    expect(await service.cleanup(true)).toMatchObject({ dryRun: true });
  });
});
