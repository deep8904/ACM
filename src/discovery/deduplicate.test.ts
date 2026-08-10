import { describe, expect, it } from "vitest";

import { createSourceItem, type SourceItemInput } from "./models/source-item";
import { deduplicateItems } from "./deduplicate";

const base: SourceItemInput = {
  sourceId: "source-a",
  sourceName: "Source A",
  sourceType: "rss",
  authority: "primary",
  title: "A release",
  url: "https://example.com/release",
  summary: "Details",
  retrievedAt: "2026-08-06T14:00:00.000Z",
  categories: [],
  tags: [],
  language: "en",
};

describe("deduplicateItems", () => {
  it("uses canonical URL, source ID, hash, then title in that order", () => {
    const items = [
      createSourceItem({ ...base, sourceItemId: "one" }),
      createSourceItem({
        ...base,
        sourceItemId: "two",
        url: `${base.url}?utm_source=x`,
      }),
      createSourceItem({
        ...base,
        sourceItemId: "one",
        url: "https://elsewhere.test/one",
      }),
      createSourceItem({
        ...base,
        sourceId: "source-b",
        sourceItemId: "hash",
        url: "https://elsewhere.test/hash",
      }),
      createSourceItem({
        ...base,
        sourceId: "source-c",
        sourceItemId: "title",
        url: "https://elsewhere.test/title",
        summary: "Different details",
      }),
    ];
    const result = deduplicateItems(items);

    expect(result.items).toHaveLength(1);
    expect(result.report).toMatchObject({
      inputCount: 5,
      outputCount: 1,
      duplicateCount: 4,
      reasonCounts: {
        "canonical-url": 1,
        "source-identifier": 1,
        "content-hash": 1,
        "normalized-title": 1,
      },
    });
  });
});
