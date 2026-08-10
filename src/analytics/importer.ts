import { basename } from "node:path";
import { sha256 } from "../writing/task";
import type { ProductionPublicationArtifact } from "../publication/models";
import type { PostedRecord, SocialPlatform } from "../social/models";
import type { AnalyticsConfig } from "./config";
import {
  analyticsImportSchema,
  articleMetricsSchema,
  socialMetricsSchema,
  type AnalyticsImport,
  type AnalyticsProviderName,
  type ArticleMetrics,
  type SocialMetrics,
} from "./models";
import { dataQuality } from "./calculations";
import {
  assertPublicPostUrl,
  normalizeCanonical,
  scrubAnalytics,
} from "./privacy";

const articleFields = [
  "record_type",
  "publication_id",
  "canonical_url",
  "window_start",
  "window_end",
  "impressions",
  "clicks",
  "sessions",
  "page_views",
  "unique_visitors",
  "engaged_sessions",
  "average_engagement_seconds",
  "bounce_rate",
  "search_impressions",
  "search_clicks",
  "search_ctr",
  "average_search_position",
  "referral_traffic",
  "social_traffic",
  "direct_traffic",
  "article_type",
  "category",
  "word_count",
  "source_count",
  "original_topic_score",
  "collected_at",
];
const socialFields = [
  "record_type",
  "publication_id",
  "posted_record_id",
  "platform",
  "post_url",
  "window_start",
  "window_end",
  "impressions",
  "views",
  "reach",
  "likes",
  "reactions",
  "comments",
  "shares",
  "reposts",
  "saves",
  "clicks",
  "profile_visits",
  "engagement_rate",
  "video_watch_time",
  "collected_at",
];
const allowed = new Set([...articleFields, ...socialFields]);
type Row = Record<string, unknown>;

function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      if (row.some((value) => value.length)) records.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted)
    throw new Error("Analytics CSV contains an unterminated quoted field");
  if (field || row.length) {
    row.push(field);
    records.push(row);
  }
  const headers = records.shift()?.map((value) => value.trim()) ?? [];
  if (!headers.length || new Set(headers).size !== headers.length)
    throw new Error("Analytics CSV headers are missing or duplicated");
  for (const header of headers)
    if (!allowed.has(header))
      throw new Error(`Unknown analytics column: ${header}`);
  return records.map((values, rowIndex) => {
    if (values.length !== headers.length)
      throw new Error(
        `Analytics CSV row ${rowIndex + 2} has the wrong column count`,
      );
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
  });
}
function rowsFrom(text: string, format: "csv" | "json") {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\0"))
    throw new Error("Analytics import encoding is invalid");
  scrubAnalytics(text);
  if (format === "csv") return parseCsv(text);
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("Analytics JSON import must be an array");
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Analytics JSON row ${index + 1} is invalid`);
    for (const key of Object.keys(value))
      if (!allowed.has(key)) throw new Error(`Unknown analytics field: ${key}`);
    return value as Row;
  });
}
const text = (row: Row, key: string, required = false) => {
  const value = row[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`${key} must be scalar`);
  const result = String(value).trim();
  if (/^[=+@]/.test(result))
    throw new Error(`Spreadsheet formula blocked in ${key}`);
  return result;
};
const number = (row: Row, key: string, rate = false) => {
  const value = text(row, key);
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (rate && parsed > 1))
    throw new Error(`${key} is outside its valid range`);
  return parsed;
};
const date = (row: Row, key: string, fallback?: string) => {
  const value = text(row, key) ?? fallback;
  if (!value) throw new Error(`${key} is required`);
  const parsed = new Date(
    value.length === 10 ? `${value}T00:00:00.000Z` : value,
  );
  if (!Number.isFinite(parsed.valueOf())) throw new Error(`${key} is invalid`);
  return parsed.toISOString();
};
function publicationFor(
  row: Row,
  publications: ProductionPublicationArtifact[],
) {
  const id = text(row, "publication_id");
  const url = text(row, "canonical_url");
  const normalized = url ? normalizeCanonical(url) : undefined;
  const matches = publications.filter((publication) =>
    id
      ? publication.id === id
      : normalizeCanonical(publication.canonicalUrl) === normalized,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Duplicate canonical publication mapping"
        : "Unknown publication mapping",
    );
  if (matches[0]!.status !== "published")
    throw new Error("Analytics may map only to published articles");
  if (
    id &&
    normalized &&
    normalizeCanonical(matches[0]!.canonicalUrl) !== normalized
  )
    throw new Error("Publication ID and canonical URL disagree");
  return matches[0]!;
}
function postFor(row: Row, posts: PostedRecord[]) {
  const url = assertPublicPostUrl(text(row, "post_url", true)!);
  const id = text(row, "posted_record_id");
  const matches = posts.filter((post) =>
    id
      ? `${post.publicationId}:${post.platform}:${post.contentHash.slice(0, 16)}` ===
        id
      : post.postUrl === url,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Duplicate posted-record mapping"
        : "Unknown social post URL",
    );
  if (matches[0]!.postUrl !== url)
    throw new Error("Posted record and URL disagree");
  return matches[0]!;
}
function normalized(
  provider: AnalyticsProviderName,
  key: string,
  value: number | null,
  category: "exposure" | "traffic" | "engagement" | "search" | "distribution",
  semantics: string,
) {
  return {
    provider,
    originalMetric: key,
    normalizedCategory: category,
    value,
    semantics,
    state: value === null ? ("not_collected" as const) : ("available" as const),
  };
}
export function normalizeImport(input: {
  body: string;
  fileName: string;
  provider: AnalyticsProviderName;
  publications: ProductionPublicationArtifact[];
  posts: PostedRecord[];
  config: AnalyticsConfig;
  now: string;
}): {
  metadata: AnalyticsImport;
  articles: ArticleMetrics[];
  social: SocialMetrics[];
  reusedHash: string;
} {
  const bytes = Buffer.byteLength(input.body);
  if (!bytes || bytes > input.config.importLimits.maximumBytes)
    throw new Error("Analytics import exceeds the configured size limit");
  const format = input.provider === "manual_csv" ? "csv" : "json";
  const rows = rowsFrom(input.body, format);
  if (rows.length > input.config.importLimits.maximumRows)
    throw new Error("Analytics import exceeds the configured row limit");
  const fileHash = sha256(input.body),
    importId = `analyticsimport_${fileHash.slice(0, 24)}`;
  const articles: ArticleMetrics[] = [],
    social: SocialMetrics[] = [],
    seen = new Set<string>();
  for (const row of rows) {
    const kind =
      text(row, "record_type") ??
      (text(row, "platform") ? "social" : "article");
    const windowStart = date(row, "window_start"),
      windowEnd = date(row, "window_end");
    if (Date.parse(windowStart) >= Date.parse(windowEnd))
      throw new Error("Analytics metric window must have positive duration");
    if (kind === "article") {
      const publication = publicationFor(row, input.publications);
      const values = {
        impressions: number(row, "impressions"),
        clicks: number(row, "clicks"),
        sessions: number(row, "sessions"),
        pageViews: number(row, "page_views"),
        uniqueVisitors: number(row, "unique_visitors"),
        engagedSessions: number(row, "engaged_sessions"),
        averageEngagementSeconds: number(row, "average_engagement_seconds"),
        bounceRate: number(row, "bounce_rate", true),
        searchImpressions: number(row, "search_impressions"),
        searchClicks: number(row, "search_clicks"),
        searchCtr: number(row, "search_ctr", true),
        averageSearchPosition: number(row, "average_search_position"),
        referralTraffic: number(row, "referral_traffic"),
        socialTraffic: number(row, "social_traffic"),
        directTraffic: number(row, "direct_traffic"),
      };
      if (
        values.searchCtr !== null &&
        values.searchClicks !== null &&
        values.searchImpressions !== null &&
        values.searchImpressions > 0 &&
        Math.abs(
          values.searchCtr - values.searchClicks / values.searchImpressions,
        ) > 0.02
      )
        throw new Error("Search CTR conflicts with clicks and impressions");
      const available = Object.values(values).filter(
        (value) => value !== null,
      ).length;
      const contentHash = sha256(
        JSON.stringify({
          publicationId: publication.id,
          windowStart,
          windowEnd,
          provider: input.provider,
          values,
        }),
      );
      if (seen.has(contentHash)) throw new Error("Duplicate analytics row");
      seen.add(contentHash);
      const providers = [input.provider];
      articles.push(
        articleMetricsSchema.parse({
          id: `articlemetric_${contentHash.slice(0, 24)}`,
          importId,
          publicationId: publication.id,
          topicId: publication.topicId,
          slug: publication.slug,
          canonicalUrl: publication.canonicalUrl,
          windowStart,
          windowEnd,
          ...values,
          sourceBreakdown: null,
          deviceBreakdown: null,
          countryBreakdown: null,
          dataCompleteness: dataQuality({
            available,
            total: Object.keys(values).length,
            providerCoverage: 0.5,
            dateCoverage: 1,
            mappingConfidence: 1,
            config: input.config,
          }),
          providers,
          normalizedMetrics: [
            normalized(
              input.provider,
              "search_clicks",
              values.searchClicks,
              "search",
              "Search-result clicks; not site sessions",
            ),
            normalized(
              input.provider,
              "page_views",
              values.pageViews,
              "traffic",
              "Provider page views; not social impressions",
            ),
          ],
          operational:
            text(row, "article_type") ||
            text(row, "category") ||
            text(row, "word_count")
              ? {
                  articleType: text(row, "article_type") ?? null,
                  categories: text(row, "category")
                    ? [text(row, "category")!]
                    : [],
                  tags: [],
                  wordCount: number(row, "word_count"),
                  readingMinutes: null,
                  sourceCount: number(row, "source_count"),
                  researchConfidence: null,
                  originalTopicScore: number(row, "original_topic_score"),
                  scoreComponents: null,
                  discoveryToApprovalSeconds: null,
                  approvalToPublicationSeconds: null,
                  editorialCycleSeconds: null,
                  reviewIterations: null,
                  draftVersions: null,
                  socialPackagesGenerated: null,
                  platformsApproved: null,
                  platformsPosted: null,
                  distributionCompletionRate: null,
                  failureCount: null,
                  retryCount: null,
                }
              : null,
          collectedAt: date(row, "collected_at", input.now),
          contentHash,
        }),
      );
    } else if (kind === "social") {
      const post = postFor(row, input.posts),
        platform = text(row, "platform", true) as SocialPlatform;
      if (platform !== post.platform)
        throw new Error("Social platform does not match posted record");
      const values = {
        impressions: number(row, "impressions"),
        views: number(row, "views"),
        reach: number(row, "reach"),
        likes: number(row, "likes"),
        reactions: number(row, "reactions"),
        comments: number(row, "comments"),
        shares: number(row, "shares"),
        reposts: number(row, "reposts"),
        saves: number(row, "saves"),
        clicks: number(row, "clicks"),
        profileVisits: number(row, "profile_visits"),
        engagementRate: number(row, "engagement_rate", true),
        videoWatchTime: number(row, "video_watch_time"),
      };
      const available = Object.values(values).filter(
        (value) => value !== null,
      ).length;
      const postedRecordId = `${post.publicationId}:${post.platform}:${post.contentHash.slice(0, 16)}`;
      const contentHash = sha256(
        JSON.stringify({
          postedRecordId,
          windowStart,
          windowEnd,
          provider: input.provider,
          values,
        }),
      );
      if (seen.has(contentHash)) throw new Error("Duplicate analytics row");
      seen.add(contentHash);
      social.push(
        socialMetricsSchema.parse({
          id: `socialmetric_${contentHash.slice(0, 24)}`,
          importId,
          postedRecordId,
          publicationId: post.publicationId,
          platform: post.platform,
          postUrl: post.postUrl,
          windowStart,
          windowEnd,
          ...values,
          dataCompleteness: dataQuality({
            available,
            total: Object.keys(values).length,
            providerCoverage: 0.5,
            dateCoverage: 1,
            mappingConfidence: 1,
            config: input.config,
          }),
          collectionMethod:
            input.provider === "manual_csv"
              ? "manual_csv"
              : input.provider === "manual_json" ||
                  input.provider === "social_manual"
                ? "manual_json"
                : "fixture",
          normalizedMetrics: [
            normalized(
              input.provider,
              "impressions",
              values.impressions,
              "exposure",
              `${post.platform} impressions retain platform-specific semantics`,
            ),
            normalized(
              input.provider,
              "clicks",
              values.clicks,
              "engagement",
              `${post.platform} reported clicks`,
            ),
          ],
          collectedAt: date(row, "collected_at", input.now),
          contentHash,
        }),
      );
    } else throw new Error(`Unknown analytics record_type: ${kind}`);
  }
  const metadata = analyticsImportSchema.parse({
    id: importId,
    provider: input.provider,
    fileHash,
    importedAt: input.now,
    fileName: basename(input.fileName),
    byteCount: bytes,
    rowCount: rows.length,
    articleRecordCount: articles.length,
    socialRecordCount: social.length,
    warnings: [],
  });
  return { metadata, articles, social, reusedHash: fileHash };
}
