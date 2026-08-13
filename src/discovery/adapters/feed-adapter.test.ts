import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { sourceConfigSchema } from "../config/source-config";
import { createFixtureFetch } from "../fixture-fetch";
import { FeedAdapter } from "./feed-adapter";

const fixtureFetch = createFixtureFetch(resolve("tests/fixtures/http"));
const context = {
  runId: "run_test_feed",
  retrievedAt: "2026-08-06T14:00:00.000Z",
  fetch: fixtureFetch,
};

describe("FeedAdapter", () => {
  it("follows a feed redirect from /feed to /feed/ without looping", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Redirected release</title><link>https://example.com/release</link><guid>redirected-1</guid></item></channel></rss>`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "/feed/" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(rss, {
          headers: { "content-type": "application/rss+xml" },
        }),
      );

    const result = await new FeedAdapter().fetchItems(
      sourceConfigSchema.parse({
        id: "redirected-rss",
        name: "Redirected RSS",
        type: "rss",
        url: "https://example.com/feed",
        authority: "primary",
      }),
      { ...context, fetch: fetchMock },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.com/feed/",
      expect.any(Object),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Redirected release");
  });

  it("parses RSS, strips markup, and skips malformed entries", async () => {
    const result = await new FeedAdapter().fetchItems(
      sourceConfigSchema.parse({
        id: "fixture-rss",
        name: "Fixture RSS",
        type: "rss",
        url: "https://fixtures.local/rss.xml",
        authority: "primary",
      }),
      context,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: "Practical platform release",
      canonicalUrl: "https://example.com/articles/release?edition=developer",
      summary: "A useful release.",
      author: "Release Team",
      sourceItemId: "rss-release-1",
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "malformed-entry",
        itemReference: "entry-2",
      }),
    ]);
  });

  it("excludes entries newer than the durable discovery window", async () => {
    const result = await new FeedAdapter().fetchItems(
      sourceConfigSchema.parse({
        id: "fixture-rss",
        name: "Fixture RSS",
        type: "rss",
        url: "https://fixtures.local/rss.xml",
        authority: "primary",
      }),
      { ...context, windowUntil: "2026-08-06T11:59:59.000Z" },
    );

    expect(result.items).toHaveLength(0);
  });

  it("treats the previous successful window boundary as exclusive", async () => {
    const result = await new FeedAdapter().fetchItems(
      sourceConfigSchema.parse({
        id: "fixture-rss",
        name: "Fixture RSS",
        type: "rss",
        url: "https://fixtures.local/rss.xml",
        authority: "primary",
      }),
      { ...context, lookbackSince: "2026-08-06T12:00:00.000Z" },
    );

    expect(result.items).toHaveLength(0);
  });

  it("parses Atom links, authors, categories, and dates", async () => {
    const result = await new FeedAdapter().fetchItems(
      sourceConfigSchema.parse({
        id: "fixture-atom",
        name: "Fixture Atom",
        type: "atom",
        url: "https://fixtures.local/atom.xml",
        authority: "independent",
      }),
      context,
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      author: "Atom Editor",
      publishedAt: "2026-08-06T12:05:00.000Z",
      categories: ["software"],
    });
    expect(result.items[1]?.summary).toBe("Details & limitations.");
  });
});
