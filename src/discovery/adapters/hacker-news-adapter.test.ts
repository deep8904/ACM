import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceConfigSchema } from "../config/source-config";
import { createFixtureFetch } from "../fixture-fetch";
import { HackerNewsAdapter } from "./hacker-news-adapter";

describe("HackerNewsAdapter", () => {
  it("normalizes valid stories and preserves discussion metrics", async () => {
    const result = await new HackerNewsAdapter().fetchItems(
      sourceConfigSchema.parse({
        id: "hacker-news",
        name: "Hacker News",
        type: "hacker-news",
        url: "https://fixtures.local/hn",
        authority: "community",
        maxItems: 3,
        mode: "top",
      }),
      {
        runId: "run_test_hn",
        retrievedAt: "2026-08-06T14:00:00.000Z",
        fetch: createFixtureFetch(resolve("tests/fixtures/http")),
        sleep: async () => undefined,
      },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceItemId: "1001",
      canonicalUrl: "https://example.org/hn-fixture",
      rawMetadata: {
        itemId: 1001,
        score: 42,
        descendants: 17,
        discussionUrl: "https://news.ycombinator.com/item?id=1001",
      },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "item-fetch-failed",
        itemReference: "9999",
      }),
    ]);
  });
});
