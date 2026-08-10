import { describe, expect, it } from "vitest";

import { rankingConfigSchema } from "./config";
import type { SuppressionDecision } from "./history";
import { storyClusterSchema, type StoryCluster } from "./models";
import { scoreCluster } from "./scoring";

const config = rankingConfigSchema.parse({
  rumorPatterns: ["reportedly", "rumored", "unconfirmed"],
  relevanceWeights: { software: 5, developer: 5, hardware: 5 },
  eventKeywords: ["release", "launch", "update"],
});
const now = new Date("2026-08-06T20:00:00.000Z");
const noSuppression: SuppressionDecision = {
  suppress: false,
  penalty: 0,
  reasons: [],
  meaningfulUpdateOverride: false,
};

describe("scoreCluster", () => {
  it("ranks a fresh primary-source event above an old low-authority story", () => {
    const fresh = scoreCluster(baseCluster(), config, noSuppression, now);
    const old = scoreCluster(
      baseCluster({
        id: "cluster_bbbbbbbbbbbbbbbbbbbbbbbb",
        representativeTitle: "Old software release",
        normalizedTitle: "old software release",
        primarySourceItemIds: [],
        authorityCounts: {
          primary: 0,
          independent: 0,
          community: 0,
          aggregator: 1,
        },
        independentSourceCount: 0,
        sourceCount: 1,
        sourceItemIds: ["old"],
        latestSignalAt: "2026-07-18T12:00:00.000Z",
        publishedAtLatest: "2026-07-18T12:00:00.000Z",
      }),
      config,
      noSuppression,
      now,
    );
    expect(fresh.score).toBeGreaterThan(old.score);
    expect(fresh.evidenceStrength).toBe("strong");
    expect(old.penalties.singleSource).toBeLessThan(0);
  });

  it("shows rumor, weak-evidence, and recent-coverage penalties with bounded scores", () => {
    const candidate = scoreCluster(
      baseCluster({
        representativeTitle: "RTX 6090 reportedly rumored",
        normalizedTitle: "rtx 6090 reportedly rumored",
        summary: "An unconfirmed leak",
        primarySourceItemIds: [],
        authorityCounts: {
          primary: 0,
          independent: 1,
          community: 0,
          aggregator: 0,
        },
        independentSourceCount: 1,
        sourceCount: 1,
      }),
      config,
      {
        suppress: true,
        penalty: 25,
        reasons: ["recent match"],
        meaningfulUpdateOverride: false,
      },
      now,
    );
    expect(candidate.score).toBeGreaterThanOrEqual(0);
    expect(candidate.score).toBeLessThanOrEqual(100);
    expect(candidate.penalties).toMatchObject({
      rumorRisk: -20,
      recentCoverage: -25,
    });
    expect(candidate.risks).toContain("rumor language: reportedly");
    expect(Object.keys(candidate.scoreBreakdown)).toHaveLength(8);
    expect(Object.keys(candidate.penalties)).toHaveLength(6);
    expect(candidate.status).toBe("suppressed");
  });

  it("normalizes strong community interest separately from evidence", () => {
    const candidate = scoreCluster(
      baseCluster({
        id: "cluster_cccccccccccccccccccccccc",
        primarySourceItemIds: [],
        authorityCounts: {
          primary: 0,
          independent: 0,
          community: 1,
          aggregator: 0,
        },
        independentSourceCount: 0,
        discussionSignals: [
          {
            provider: "hacker-news",
            sourceItemId: "hn",
            score: 500,
            comments: 250,
            ageHours: 2,
            normalizedVelocity: 1,
          },
        ],
      }),
      config,
      noSuppression,
      now,
    );
    expect(candidate.scoreBreakdown.discussionVelocity).toBe(15);
    expect(candidate.evidenceStrength).toBe("insufficient");
  });
});

function baseCluster(overrides: Partial<StoryCluster> = {}): StoryCluster {
  return storyClusterSchema.parse({
    id: "cluster_aaaaaaaaaaaaaaaaaaaaaaaa",
    runId: "run_scoring_test",
    representativeTitle: "Developer software release",
    representativeTitleReason: "primary",
    normalizedTitle: "developer software release",
    summary:
      "A useful software release with developer workflow tradeoffs and limitations.",
    sourceItemIds: ["one", "two", "three"],
    sourceIds: ["one", "two", "three"],
    primarySourceItemIds: ["one"],
    authorityCounts: {
      primary: 1,
      independent: 2,
      community: 0,
      aggregator: 0,
    },
    categories: ["software"],
    keywords: ["developer", "software", "release", "workflow"],
    entities: ["Example"],
    productIdentifiers: ["Example 2.0"],
    eventKeywords: ["release"],
    firstSeenAt: "2026-08-06T15:00:00.000Z",
    latestSignalAt: "2026-08-06T19:00:00.000Z",
    publishedAtEarliest: "2026-08-06T15:00:00.000Z",
    publishedAtLatest: "2026-08-06T19:00:00.000Z",
    sourceCount: 3,
    independentSourceCount: 3,
    discussionSignals: [],
    clusterConfidence: 0.8,
    clusterReasons: ["test"],
    fingerprint: "a".repeat(64),
    status: "active",
    ...overrides,
  });
}
