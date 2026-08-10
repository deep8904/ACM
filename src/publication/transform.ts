import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ResearchSource } from "../research/models";
import type { ArticleDraft } from "../writing/models";
import { inspectMdx, renderFrontmatter } from "../writing/mdx";
import type { PublicationConfig } from "./config";
import {
  publishedArticleSnapshotSchema,
  sourceReferenceSchema,
  type SourceReference,
} from "./models";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function publicSourceUrl(value: string, production = false): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol))
    throw new Error("Unsafe source URL scheme");
  if (production && url.protocol !== "https:")
    throw new Error("Public source URL must use HTTPS");
  if (url.username || url.password || privateHost(url.hostname))
    throw new Error("Private source URL is forbidden");
  for (const key of [...url.searchParams.keys()])
    if (
      /^(?:utm_.+|fbclid|gclid|token|key|secret|password|signature|auth)$/i.test(
        key,
      )
    )
      url.searchParams.delete(key);
  url.hash = "";
  return url.toString();
}

function privateHost(host: string) {
  return /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(
    host,
  );
}

export function canonicalUrl(config: PublicationConfig, slug: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error("Unsafe article slug");
  const origin = config.siteOrigin.replace(/\/+$/, "");
  const prefix = config.blogRoutePrefix.replace(/\/+$/, "");
  const value = new URL(`${prefix}/${encodeURIComponent(slug)}`, `${origin}/`);
  if (value.search || value.hash)
    throw new Error("Canonical URL cannot contain query or fragment");
  return value.toString().replace(/\/$/, "");
}

export function articlePath(
  config: PublicationConfig,
  slug: string,
  publishedAt: string,
) {
  const path = config.pathPattern
    .replace("{year}", String(new Date(publishedAt).getUTCFullYear()))
    .replace("{slug}", slug);
  const normalized = posix.normalize(path);
  const root = config.contentRoot.replace(/\/+$/, "");
  if (
    normalized !== path ||
    !normalized.startsWith(`${root}/`) ||
    normalized.includes("..") ||
    /(?:^|\/)\./.test(normalized) ||
    !normalized.endsWith(".mdx")
  )
    throw new Error("Article path escapes the configured content root");
  return normalized;
}

export function renderCitations(
  mdx: string,
  sources: ResearchSource[],
  accessedAt: string,
  production = false,
) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const order: string[] = [];
  const body = mdx.replace(
    /\[(source|sources):([^\]]+)\]/g,
    (_all, _kind: string, raw: string) => {
      const ids = raw
        .split(",")
        .map((x: string) => x.trim())
        .filter(Boolean);
      if (!ids.length) throw new Error("Empty citation marker");
      return ids
        .map((id: string) => {
          if (!byId.has(id)) throw new Error(`Unknown citation source: ${id}`);
          if (!order.includes(id)) order.push(id);
          return `[^${order.indexOf(id) + 1}]`;
        })
        .join("");
    },
  );
  const references: SourceReference[] = order.map((id, index) => {
    const source = byId.get(id)!;
    return sourceReferenceSchema.parse({
      id: `ref_${digest(id).slice(0, 16)}`,
      label: source.isPrimary
        ? `Primary source ${index + 1}`
        : `Source ${index + 1}`,
      publisher: source.publisher,
      title: source.title,
      url: publicSourceUrl(source.canonicalUrl, production),
      publishedAt: source.publishedAt,
      isPrimary: source.isPrimary,
      accessedAt,
      type: source.sourceType,
    });
  });
  const footnotes = references
    .map(
      (ref, i) =>
        `[^${i + 1}]: [${escapeLabel(ref.title)}](${ref.url}) — ${escapeLabel(ref.publisher)}${ref.publishedAt ? `, ${new Date(ref.publishedAt).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}` : ""}${ref.isPrimary ? " (primary source)" : ""}.`,
    )
    .join("\n");
  return { body: `${body.trim()}\n\n${footnotes}\n`, references };
}
const escapeLabel = (x: string) =>
  x
    .replace(/[\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function transformForPublication(input: {
  draft: ArticleDraft;
  sources: ResearchSource[];
  config: PublicationConfig;
  publishedAt: string;
}) {
  const { draft, config, publishedAt } = input;
  const citations = renderCitations(
    draft.mdx,
    input.sources,
    publishedAt,
    config.mode === "github",
  );
  const known = new Set(input.sources.map((x) => x.id));
  const inspection = inspectMdx(citations.body, known);
  if (inspection.safetyIssues.length)
    throw new Error(
      `Published MDX is unsafe: ${inspection.safetyIssues.join("; ")}`,
    );
  if (
    /articleevent_|draft_|review_|packet_|source_|claim_|telegram|approvalNotes/i.test(
      citations.body,
    )
  )
    throw new Error("Private identifier detected in public body");
  const url = canonicalUrl(config, draft.slug);
  const frontmatter = {
    title: draft.title,
    slug: draft.slug,
    description: draft.description,
    publishedAt,
    updatedAt: publishedAt,
    status: "published",
    category: draft.category,
    tags: draft.tags,
    author: draft.author,
    heroImage: null,
    heroAlt: draft.heroAlt,
    canonicalUrl: url,
    sources: citations.references.map((x) => x.url),
    draft: false,
    articleType: draft.articleType,
    readingTime: draft.readingTimeMinutes,
    sourceDisclosure:
      draft.articleType === "source_based_review"
        ? "Source-based analysis; no hands-on testing is claimed."
        : "Sources are listed as numbered references.",
  };
  const mdx = `${renderFrontmatter(frontmatter)}\n${citations.body}`;
  const contentHash = digest(mdx);
  return publishedArticleSnapshotSchema.parse({
    title: draft.title,
    slug: draft.slug,
    description: draft.description,
    category: draft.category,
    tags: draft.tags,
    author: draft.author,
    articleType: draft.articleType,
    publishedAt,
    updatedAt: publishedAt,
    canonicalUrl: url,
    heroImage: null,
    heroAlt: draft.heroAlt,
    sourceDisclosure: frontmatter.sourceDisclosure,
    sources: citations.references,
    mdx,
    contentHash,
  });
}

export function validatePublicArtifact(mdx: string) {
  const forbidden = [
    /TELEGRAM_BOT_TOKEN/i,
    /approvalNotes/i,
    /selectedExcerpts/i,
    /(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S+/i,
    /https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i,
    /\[source(?:s)?:/i,
  ];
  const hit = forbidden.find((x) => x.test(mdx));
  if (hit)
    throw new Error("Private or unresolved data detected in public artifact");
  const quotes = [...mdx.matchAll(/[“\"]([^”\"\n]{1,500})[”\"]/g)].map(
    (x) => (x[1] ?? "").split(/\s+/).length,
  );
  if (quotes.some((count) => count > 50))
    throw new Error("Quotation exceeds the public copyright limit");
}
