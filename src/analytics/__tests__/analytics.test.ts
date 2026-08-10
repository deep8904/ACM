import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import {
  publicationRecordSchema,
  type ProductionPublicationArtifact,
} from "../../publication/models";
import { productionArtifactFixture } from "../../publication/__tests__/production-artifact-fixture";
import { analyticsConfigSchema } from "../config";
import { dataQuality, deriveMetrics, median } from "../calculations";
import { normalizeImport } from "../importer";
import { dataCompletenessSchema, normalizedMetricSchema } from "../models";
import { scrubAnalytics, normalizeCanonical } from "../privacy";
import {
  SearchConsoleAnalyticsAdapter,
  UnavailableVercelAnalyticsAdapter,
} from "../providers";

const hex = "a".repeat(64);
const now = "2026-06-30T00:00:00.000Z";
const config = analyticsConfigSchema.parse(
  parse(await readFile("automation/config/analytics.example.yaml", "utf8")),
);

function publication(index: number): ProductionPublicationArtifact {
  const id = String(index).repeat(24);
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
      title: `Article ${index}`,
      slug: `article-${index}`,
      articlePath: `content/article-${index}.mdx`,
      repository: "fixture/blog",
      branch: "main",
      commitSha: hex,
      deploymentProvider: "mock",
      canonicalUrl: `https://deep.example/article-${index}`,
      publishedAt: "2026-06-01T00:00:00.000Z",
      sourceCount: 4,
      contentHash: hex,
      approvedSnapshotHash: hex,
      publishedSnapshotHash: hex,
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      warnings: [],
      provenance: { mode: "fixture", parentSha: hex },
      version: 1,
    }),
  );
}

describe("analytics models and calculations", () => {
  it("keeps missing distinct from zero and rejects invalid values", () => {
    expect(
      normalizedMetricSchema.parse({
        provider: "manual_json",
        originalMetric: "views",
        normalizedCategory: "traffic",
        value: null,
        semantics: "Aggregate views",
        state: "not_collected",
      }).value,
    ).toBeNull();
    expect(() =>
      normalizedMetricSchema.parse({
        provider: "unknown",
        originalMetric: "views",
        normalizedCategory: "traffic",
        value: -1,
        semantics: "x",
        state: "available",
      }),
    ).toThrow();
    expect(() =>
      dataCompletenessSchema.parse({
        label: "high",
        score: 1.1,
        providerCoverage: 1,
        dateCoverage: 1,
        mappingConfidence: 1,
        metricStates: {},
        stale: false,
        partialWindow: false,
        conflicts: [],
        warnings: [],
      }),
    ).toThrow();
  });

  it("uses outlier-resistant medians and quality penalties", () => {
    expect(median([1, 2, 100])).toBe(2);
    expect(
      dataQuality({
        available: 10,
        total: 10,
        providerCoverage: 1,
        dateCoverage: 1,
        mappingConfidence: 1,
        stale: true,
        conflicts: ["provider conflict"],
        config,
      }).score,
    ).toBeLessThan(0.8);
  });

  it("calculates ratios null-safely and avoids division by zero", () => {
    const derived = deriveMetrics([], [], 7);
    expect(derived.searchCtr).toBeNull();
    expect(derived.viewsPerDay).toBeNull();
    expect(derived.performanceIndex).toBeNull();
  });
});

describe("manual imports and privacy", () => {
  it("normalizes an offline CSV and canonical trailing slash", async () => {
    const body = await readFile(
      "tests/fixtures/analytics/article-metrics.csv",
      "utf8",
    );
    const result = normalizeImport({
      body,
      fileName: "article-metrics.csv",
      provider: "manual_csv",
      publications: [1, 2, 3, 4, 5].map(publication),
      posts: [],
      config,
      now,
    });
    expect(result.articles).toHaveLength(5);
    expect(result.articles[4]!.searchClicks).toBeNull();
    expect(normalizeCanonical("https://deep.example/article-1/")).toBe(
      "https://deep.example/article-1",
    );
  });

  it("rejects unknown pages, private query parameters, negative metrics, and personal data", () => {
    const base = [
      {
        record_type: "article",
        canonical_url: "https://deep.example/unknown",
        window_start: "2026-06-01",
        window_end: "2026-06-08",
        search_clicks: 1,
      },
    ];
    expect(() =>
      normalizeImport({
        body: JSON.stringify(base),
        fileName: "x.json",
        provider: "manual_json",
        publications: [publication(1)],
        posts: [],
        config,
        now,
      }),
    ).toThrow(/Unknown publication/);
    expect(() =>
      normalizeCanonical("https://deep.example/article-1?token=secret"),
    ).toThrow();
    expect(() =>
      normalizeImport({
        body: JSON.stringify([
          {
            ...base[0],
            canonical_url: "https://deep.example/article-1",
            search_clicks: -1,
          },
        ]),
        fileName: "x.json",
        provider: "manual_json",
        publications: [publication(1)],
        posts: [],
        config,
        now,
      }),
    ).toThrow(/valid range/);
    expect(() => scrubAnalytics('{"email":"visitor@example.com"}')).toThrow(
      /email address/,
    );
  });

  it("produces a stable content hash for replay and a new hash for modification", async () => {
    const body = await readFile(
        "tests/fixtures/analytics/article-metrics.csv",
        "utf8",
      ),
      publications = [1, 2, 3, 4, 5].map(publication);
    const one = normalizeImport({
      body,
      fileName: "one.csv",
      provider: "manual_csv",
      publications,
      posts: [],
      config,
      now,
    });
    const replay = normalizeImport({
      body,
      fileName: "two.csv",
      provider: "manual_csv",
      publications,
      posts: [],
      config,
      now,
    });
    const changed = normalizeImport({
      body: body.replace("10000,1200", "10001,1200"),
      fileName: "three.csv",
      provider: "manual_csv",
      publications,
      posts: [],
      config,
      now,
    });
    expect(replay.reusedHash).toBe(one.reusedHash);
    expect(changed.reusedHash).not.toBe(one.reusedHash);
  });
});

describe("provider boundaries", () => {
  it("paginates Search Console rows with an injected transport", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { keys: ["p1"], clicks: 1, impressions: 2, ctr: 0.5, position: 1 },
          { keys: ["p2"], clicks: 2, impressions: 4, ctr: 0.5, position: 2 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const adapter = new SearchConsoleAnalyticsAdapter({
      siteUrl: "sc-domain:deep.example",
      transport: { query },
      pageSize: 2,
    });
    expect(
      await adapter.collectArticleMetrics({
        canonicalUrls: [],
        windowStart: "2026-06-01T00:00:00Z",
        windowEnd: "2026-06-08T00:00:00Z",
        dimensions: ["page"],
      }),
    ).toHaveLength(2);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startRow: 2 }),
    );
  });

  it("documents Vercel as unavailable instead of pretending to collect", async () => {
    const adapter = new UnavailableVercelAnalyticsAdapter();
    expect((await adapter.getCapabilities()).liveAccess).toBe(false);
    await expect(adapter.collectSiteMetrics()).rejects.toThrow(
      /manual aggregate export/,
    );
  });
});
