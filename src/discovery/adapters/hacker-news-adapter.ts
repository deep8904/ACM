import { z } from "zod";

import type { SourceConfig } from "../config/source-config";
import { fetchTextWithPolicy } from "../http";
import { createSourceItem, type SourceItem } from "../models/source-item";
import { stripMarkup } from "../text";
import type {
  AdapterContext,
  AdapterResult,
  AdapterWarning,
  TrendSourceAdapter,
} from "./types";

const storyIdsSchema = z.array(z.number().int().positive());
const hackerNewsItemSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().optional(),
  by: z.string().optional(),
  time: z.number().int().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  score: z.number().int().optional(),
  descendants: z.number().int().optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
});

export class HackerNewsAdapter implements TrendSourceAdapter {
  readonly supportedTypes = ["hacker-news"] as const;

  async fetchItems(
    source: SourceConfig,
    context: AdapterContext,
  ): Promise<AdapterResult> {
    const baseUrl = source.url.replace(/\/+$/, "");
    const limit = Math.min(
      source.maxItems,
      context.maxItems ?? source.maxItems,
    );
    const ids = storyIdsSchema
      .parse(
        await fetchJson(
          `${baseUrl}/${source.mode}stories.json`,
          source,
          context,
        ),
      )
      .slice(0, limit);
    const warnings: AdapterWarning[] = [];

    const fetched = await mapWithConcurrency(ids, 5, async (id) => {
      try {
        const raw = await fetchJson(
          `${baseUrl}/item/${id}.json`,
          source,
          context,
        );
        return { id, item: hackerNewsItemSchema.parse(raw) };
      } catch (error) {
        warnings.push({
          code: "item-fetch-failed",
          message: errorMessage(error),
          itemReference: String(id),
        });
        return { id, item: undefined };
      }
    });

    const items: SourceItem[] = [];
    for (const { item } of fetched) {
      if (
        !item ||
        item.deleted ||
        item.dead ||
        item.type !== "story" ||
        !item.title
      )
        continue;
      const normalized = normalizeHackerNewsItem(
        item,
        source,
        context.retrievedAt,
      );
      if (
        context.lookbackSince &&
        normalized.publishedAt &&
        normalized.publishedAt < context.lookbackSince
      ) {
        continue;
      }
      items.push(normalized);
    }

    warnings.sort((a, b) =>
      (a.itemReference ?? "").localeCompare(b.itemReference ?? ""),
    );

    return { items, warnings };
  }
}

function normalizeHackerNewsItem(
  item: z.infer<typeof hackerNewsItemSchema>,
  source: SourceConfig,
  retrievedAt: string,
): SourceItem {
  const discussionUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  return createSourceItem({
    sourceId: source.id,
    sourceName: source.name,
    sourceType: "hacker-news",
    authority: source.authority,
    sourceItemId: String(item.id),
    title: item.title ?? "",
    url: item.url ?? discussionUrl,
    summary: item.text ? stripMarkup(item.text) : "",
    author: item.by,
    publishedAt: item.time
      ? new Date(item.time * 1_000).toISOString()
      : undefined,
    retrievedAt,
    categories: source.topics,
    tags: ["hacker-news", source.mode],
    language: source.language,
    rawMetadata: {
      itemId: item.id,
      score: item.score ?? 0,
      descendants: item.descendants ?? 0,
      discussionUrl,
    },
  });
}

async function fetchJson(
  url: string,
  source: SourceConfig,
  context: AdapterContext,
): Promise<unknown> {
  const { text } = await fetchTextWithPolicy(url, {
    fetch: context.fetch,
    timeoutMs: source.timeoutMs,
    maxBytes: 1_000_000,
    maxRedirects: 2,
    retries: 2,
    sleep: context.sleep,
    acceptedContentTypes: ["application/json", "text/json"],
  });
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}`, { cause: error });
  }
}

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await task(value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
