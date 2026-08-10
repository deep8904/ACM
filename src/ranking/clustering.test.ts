import { describe, expect, it } from "vitest";

import {
  createSourceItem,
  type SourceItemInput,
} from "../discovery/models/source-item";
import { clusterStories } from "./clustering";
import { rankingConfigSchema } from "./config";

const config = rankingConfigSchema.parse({
  clustering: { threshold: 0.45, completeLinkRatio: 0.9 },
  eventKeywords: ["release"],
});

describe("clusterStories", () => {
  it("is deterministic and blocks transitive bridge over-clustering", () => {
    const items = [
      item("Alpha beta release", "a", "independent"),
      item("Alpha beta gamma delta release", "b", "independent"),
      item("Gamma delta release", "c", "independent"),
    ];
    const first = clusterStories(
      "run_cluster_test",
      items,
      config,
      new Date("2026-08-06T14:00:00Z"),
    );
    const second = clusterStories(
      "run_cluster_test",
      items,
      config,
      new Date("2026-08-06T14:00:00Z"),
    );
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect(
      first.map(({ sourceItemIds }) => sourceItemIds.length).sort(),
    ).toEqual([1, 2]);
  });

  it("selects the primary source title and preserves every source item ID", () => {
    const independent = item(
      "Tool release for developers explained",
      "news",
      "independent",
    );
    const primary = item("Tool release for developers", "official", "primary");
    const [cluster] = clusterStories(
      "run_primary_test",
      [independent, primary],
      rankingConfigSchema.parse({
        clustering: { threshold: 0.4 },
        eventKeywords: ["release"],
      }),
      new Date("2026-08-06T14:00:00Z"),
    );
    expect(cluster?.representativeTitle).toBe(primary.title);
    expect(cluster?.sourceItemIds.sort()).toEqual(
      [independent.id, primary.id].sort(),
    );
  });
});

function item(
  title: string,
  suffix: string,
  authority: SourceItemInput["authority"],
) {
  return createSourceItem({
    sourceId: `source-${suffix}`,
    sourceName: `Source ${suffix}`,
    sourceType: "rss",
    authority,
    title,
    url: `https://${suffix}.example/story`,
    summary: title,
    publishedAt: "2026-08-06T12:00:00.000Z",
    retrievedAt: "2026-08-06T13:00:00.000Z",
    language: "en",
  });
}
