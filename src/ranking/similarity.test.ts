import { describe, expect, it } from "vitest";

import {
  createSourceItem,
  type SourceItemInput,
} from "../discovery/models/source-item";
import { rankingConfigSchema } from "./config";
import { calculateSimilarity, featureItem } from "./similarity";

const config = rankingConfigSchema.parse({
  clustering: { threshold: 0.55, maxComparisonHours: 72 },
  eventKeywords: ["release", "launch", "update"],
  entityRules: [
    { canonical: "OpenAI", type: "organization", aliases: ["OpenAI"] },
    { canonical: "GPT-5 API", type: "product", aliases: ["GPT-5 API"] },
    { canonical: "GPT-5 Mini", type: "product", aliases: ["GPT-5 Mini"] },
  ],
});

describe("calculateSimilarity", () => {
  it("matches the same event from different publishers with explanations", () => {
    const result = compare(
      item("OpenAI releases GPT-5 API", "https://one.test/a"),
      item("GPT-5 API release from OpenAI", "https://two.test/b", {
        sourceId: "two",
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0.55);
    expect(result.reasons).toContain("shared entity: OpenAI");
    expect(result.reasons).toContain("shared product identifier: GPT-5 API");
  });

  it("keeps different products from the same company separate", () => {
    const result = compare(
      item("OpenAI releases GPT-5 API", "https://one.test/a"),
      item("OpenAI releases GPT-5 Mini", "https://two.test/b", {
        sourceId: "two",
      }),
    );
    expect(result.score).toBeLessThanOrEqual(0.35);
    expect(result.reasons).toContain(
      "different product identifiers prevent merge",
    );
  });

  it("rejects distant signals and entity-only similarity", () => {
    const distant = compare(
      item("OpenAI releases GPT-5 API", "https://one.test/a"),
      item("OpenAI releases GPT-5 API", "https://two.test/b", {
        sourceId: "two",
        publishedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    const entityOnly = compare(
      item("OpenAI hiring changes", "https://one.test/c"),
      item("OpenAI office policy opinion", "https://two.test/d", {
        sourceId: "two",
      }),
    );
    expect(distant.score).toBe(0);
    expect(entityOnly.score).toBeLessThan(0.55);
  });
});

function compare(
  left: ReturnType<typeof item>,
  right: ReturnType<typeof item>,
) {
  return calculateSimilarity(
    featureItem(left, config),
    featureItem(right, config),
    config,
  );
}

function item(
  title: string,
  url: string,
  overrides: Partial<SourceItemInput> = {},
) {
  return createSourceItem({
    sourceId: "one",
    sourceName: "One",
    sourceType: "rss",
    authority: "independent",
    title,
    url,
    summary: `${title} details for developers`,
    publishedAt: "2026-08-06T12:00:00.000Z",
    retrievedAt: "2026-08-06T13:00:00.000Z",
    language: "en",
    ...overrides,
  });
}
