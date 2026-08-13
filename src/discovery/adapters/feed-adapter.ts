import { XMLParser } from "fast-xml-parser";

import type { SourceConfig } from "../config/source-config";
import { fetchTextWithPolicy } from "../http";
import { createSourceItem } from "../models/source-item";
import { stripMarkup } from "../text";
import type {
  AdapterContext,
  AdapterResult,
  AdapterWarning,
  TrendSourceAdapter,
} from "./types";

type XmlValue = unknown;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  removeNSPrefix: true,
  trimValues: true,
  processEntities: true,
});

export class FeedAdapter implements TrendSourceAdapter {
  readonly supportedTypes = ["rss", "atom"] as const;

  async fetchItems(
    source: SourceConfig,
    context: AdapterContext,
  ): Promise<AdapterResult> {
    const { text } = await fetchTextWithPolicy(source.url, {
      fetch: context.fetch,
      timeoutMs: source.timeoutMs,
      maxBytes: 2_000_000,
      maxRedirects: 3,
      acceptedContentTypes: [
        "application/rss+xml",
        "application/atom+xml",
        "application/xml",
        "text/xml",
      ],
    });

    let document: Record<string, unknown>;
    try {
      document = parser.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Could not parse feed ${source.id}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    const warnings: AdapterWarning[] = [];
    const entries = getEntries(document, source.type);
    const limit = Math.min(
      source.maxItems,
      context.maxItems ?? source.maxItems,
    );
    const items = [];

    for (const [index, rawEntry] of entries.entries()) {
      if (items.length >= limit) break;
      try {
        const item = normalizeFeedEntry(rawEntry, source, context.retrievedAt);
        if (
          context.lookbackSince &&
          item.publishedAt &&
          item.publishedAt <= context.lookbackSince
        ) {
          continue;
        }
        if (
          context.windowUntil &&
          item.publishedAt &&
          item.publishedAt > context.windowUntil
        ) {
          continue;
        }
        items.push(item);
      } catch (error) {
        warnings.push({
          code: "malformed-entry",
          message: errorMessage(error),
          itemReference: `entry-${index + 1}`,
        });
      }
    }

    if (entries.length === 0) {
      warnings.push({
        code: "empty-feed",
        message: `No entries found in ${source.id}`,
      });
    }

    return { items, warnings };
  }
}

function getEntries(
  document: Record<string, unknown>,
  configuredType: SourceConfig["type"],
): unknown[] {
  if (configuredType === "atom") {
    return asArray(asObject(document.feed)?.entry);
  }
  const channel = asObject(asObject(document.rss)?.channel);
  return asArray(channel?.item);
}

function normalizeFeedEntry(
  rawEntry: unknown,
  source: SourceConfig,
  retrievedAt: string,
) {
  const entry = asObject(rawEntry);
  if (!entry) throw new Error("Feed entry is not an object");

  const title = getText(entry.title);
  const url =
    source.type === "atom" ? getAtomLink(entry.link) : getText(entry.link);
  if (!title) throw new Error("Feed entry has no title");
  if (!url) throw new Error("Feed entry has no usable link");

  const sourceItemId = getText(entry.guid) || getText(entry.id) || undefined;
  const publishedValue =
    getText(entry.pubDate) ||
    getText(entry.published) ||
    getText(entry.updated) ||
    getText(entry.date);
  const publishedAt = publishedValue ? parseDate(publishedValue) : undefined;
  const categories = [
    ...asArray(entry.category).map(
      (value) => getText(value) || getAttribute(value, "term"),
    ),
    ...source.topics,
  ].filter((value): value is string => Boolean(value));
  const description =
    getText(entry.description) ||
    getText(entry.summary) ||
    getText(entry.content) ||
    "";

  return createSourceItem({
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    authority: source.authority,
    sourceItemId,
    title: stripMarkup(title),
    url,
    summary: stripMarkup(description),
    author:
      getText(entry.creator) ||
      getText(asObject(entry.author)?.name) ||
      getText(entry.author) ||
      undefined,
    publishedAt,
    retrievedAt,
    categories,
    tags: [],
    language: source.language,
    rawMetadata: sourceItemId ? { sourceItemId } : {},
  });
}

function getAtomLink(value: unknown): string {
  const links = asArray(value);
  for (const link of links) {
    if (typeof link === "string") return link;
    const object = asObject(link);
    const href = object?.["@href"];
    const relation = object?.["@rel"];
    if (
      typeof href === "string" &&
      (relation === undefined || relation === "alternate")
    )
      return href;
  }
  return "";
}

function getText(value: XmlValue): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value).trim();
  if (Array.isArray(value)) return getText(value[0]);
  const object = asObject(value);
  return object ? getText(object["#text"]) : "";
}

function getAttribute(value: unknown, name: string): string {
  const attribute = asObject(value)?.[`@${name}`];
  return typeof attribute === "string" ? attribute : "";
}

function parseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid publication date: ${value}`);
  return date.toISOString();
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
