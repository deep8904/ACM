import { describe, expect, it } from "vitest";

import { parseRankingConfig } from "./config";

describe("parseRankingConfig", () => {
  it("applies safe defaults", () => {
    const config = parseRankingConfig("{}");
    expect(config.clustering).toMatchObject({
      threshold: 0.64,
      completeLinkRatio: 0.9,
      keywordCount: 12,
    });
    expect(
      Object.values(config.scoring.positive).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(100);
  });

  it("rejects impossible totals and packet sizes", () => {
    expect(() =>
      parseRankingConfig(`
output:
  maxRankedCandidates: 5
  aiPacketSize: 10
scoring:
  positive:
    freshness: 1
`),
    ).toThrow(/total 100|cannot exceed/);
  });
});
