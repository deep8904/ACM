import { describe, expect, it } from "vitest";

import { rankingConfigSchema } from "./config";
import { evaluateRecentCoverage } from "./history";
import { historyEntrySchema, storyClusterSchema } from "./models";

const config = rankingConfigSchema.parse({
  meaningfulUpdateTerms: ["security", "fixes"],
});
const now = new Date("2026-08-06T20:00:00.000Z");
const history = [
  historyEntrySchema.parse({
    id: "past",
    status: "published",
    title: "Figma Sites launch",
    entities: ["Figma"],
    keywords: ["figma", "sites", "launch"],
    productIdentifiers: ["Figma Sites"],
    eventKeywords: ["launch"],
    clusterFingerprint: "past-fingerprint",
    date: "2026-07-28T12:00:00.000Z",
  }),
];

describe("evaluateRecentCoverage", () => {
  it("suppresses a substantially overlapping recent topic", () => {
    const decision = evaluateRecentCoverage(
      cluster("Figma Sites launch", ["launch"]),
      history,
      config,
      now,
    );
    expect(decision.suppress).toBe(true);
    expect(decision.penalty).toBe(25);
  });

  it("allows a meaningful follow-up update with an explanation", () => {
    const decision = evaluateRecentCoverage(
      cluster("Figma Sites security update fixes exports", [
        "update",
        "security",
        "fixes",
      ]),
      history,
      config,
      now,
    );
    expect(decision).toMatchObject({
      suppress: false,
      penalty: 0,
      meaningfulUpdateOverride: true,
    });
    expect(decision.reasons[0]).toMatch(/meaningful update override/);
  });
});

function cluster(title: string, eventKeywords: string[]) {
  return storyClusterSchema.parse({
    id: "cluster_aaaaaaaaaaaaaaaaaaaaaaaa",
    runId: "run_history_test",
    representativeTitle: title,
    representativeTitleReason: "test",
    normalizedTitle: title.toLowerCase(),
    summary: title,
    sourceItemIds: ["item"],
    sourceIds: ["source"],
    primarySourceItemIds: ["item"],
    authorityCounts: {
      primary: 1,
      independent: 0,
      community: 0,
      aggregator: 0,
    },
    categories: ["design"],
    keywords: title.toLowerCase().split(" "),
    entities: ["Figma"],
    productIdentifiers: ["Figma Sites"],
    eventKeywords,
    firstSeenAt: "2026-08-06T18:00:00.000Z",
    latestSignalAt: "2026-08-06T19:00:00.000Z",
    publishedAtEarliest: "2026-08-06T18:00:00.000Z",
    publishedAtLatest: "2026-08-06T19:00:00.000Z",
    sourceCount: 1,
    independentSourceCount: 1,
    discussionSignals: [],
    clusterConfidence: 0.8,
    clusterReasons: ["test"],
    fingerprint: "a".repeat(64),
    status: "active",
  });
}
