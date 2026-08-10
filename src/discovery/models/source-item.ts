import { createHash } from "node:crypto";

import { z } from "zod";

import { normalizeUrl } from "../normalize-url";

export const sourceTypeSchema = z.enum(["rss", "atom", "hacker-news"]);
export const sourceAuthoritySchema = z.enum([
  "primary",
  "independent",
  "community",
  "aggregator",
]);

export const sourceItemSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceType: sourceTypeSchema,
  authority: sourceAuthoritySchema,
  sourceItemId: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.string().url(),
  canonicalUrl: z.string().url(),
  summary: z.string(),
  author: z.string().min(1).optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  retrievedAt: z.string().datetime({ offset: true }),
  categories: z.array(z.string()),
  tags: z.array(z.string()),
  language: z.string().min(2),
  rawMetadata: z.record(z.string(), z.unknown()),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type SourceType = z.infer<typeof sourceTypeSchema>;
export type SourceAuthority = z.infer<typeof sourceAuthoritySchema>;
export type SourceItem = z.infer<typeof sourceItemSchema>;

export interface SourceItemInput {
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  authority: SourceAuthority;
  sourceItemId?: string;
  title: string;
  url: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  retrievedAt: string;
  categories?: string[];
  tags?: string[];
  language: string;
  rawMetadata?: Record<string, unknown>;
}

export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function hashContent(title: string, summary: string): string {
  return createHash("sha256")
    .update(
      `${normalizeText(title).toLocaleLowerCase("en")}\n${normalizeText(summary)}`,
    )
    .digest("hex");
}

export function createSourceItem(input: SourceItemInput): SourceItem {
  const title = normalizeText(input.title);
  const summary = normalizeText(input.summary ?? "");
  const canonicalUrl = normalizeUrl(input.url);
  const stableKey = input.sourceItemId ?? canonicalUrl;
  const id = `item_${createHash("sha256")
    .update(`${input.sourceId}\0${stableKey}`)
    .digest("hex")
    .slice(0, 24)}`;

  return sourceItemSchema.parse({
    ...input,
    id,
    title,
    url: input.url,
    canonicalUrl,
    summary,
    author: input.author ? normalizeText(input.author) : undefined,
    publishedAt: input.publishedAt
      ? new Date(input.publishedAt).toISOString()
      : undefined,
    categories: uniqueStrings(input.categories ?? []),
    tags: uniqueStrings(input.tags ?? []),
    rawMetadata: input.rawMetadata ?? {},
    contentHash: hashContent(title, summary),
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}
