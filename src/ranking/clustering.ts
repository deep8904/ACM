import { createHash } from "node:crypto";

import type { SourceItem } from "../discovery/models/source-item";
import type { RankingConfig } from "./config";
import { extractFeatures } from "./features";
import {
  storyClusterSchema,
  type DiscussionSignal,
  type StoryCluster,
} from "./models";
import {
  calculateSimilarity,
  featureItem,
  type FeaturedItem,
  type SimilarityResult,
} from "./similarity";

interface WorkingCluster {
  members: FeaturedItem[];
  edgeReasons: string[];
}

export function clusterStories(
  runId: string,
  items: readonly SourceItem[],
  config: RankingConfig,
  now: Date,
): StoryCluster[] {
  const cutoff = now.getTime() - config.clustering.lookbackHours * 3_600_000;
  const featured = items
    .filter(
      (item) => Date.parse(item.publishedAt ?? item.retrievedAt) >= cutoff,
    )
    .map((item) => featureItem(item, config));
  const working: WorkingCluster[] = [];

  for (const candidate of featured) {
    const matches = working
      .map((cluster, index) => ({
        index,
        result: clusterFit(candidate, cluster, config),
      }))
      .filter(({ result }) => result.accepted)
      .sort((a, b) => b.result.average - a.result.average || a.index - b.index);
    const best = matches[0];
    if (!best) {
      working.push({ members: [candidate], edgeReasons: [] });
      continue;
    }
    working[best.index]?.members.push(candidate);
    working[best.index]?.edgeReasons.push(...best.result.reasons);
  }

  return working.map((cluster) => buildCluster(runId, cluster, config, now));
}

function clusterFit(
  candidate: FeaturedItem,
  cluster: WorkingCluster,
  config: RankingConfig,
): { accepted: boolean; average: number; reasons: string[] } {
  const similarities = cluster.members.map((member) =>
    calculateSimilarity(candidate, member, config),
  );
  const representative = similarities[0];
  const minimum = Math.min(...similarities.map(({ score }) => score));
  const average = averageOf(similarities.map(({ score }) => score));
  const accepted =
    (representative?.score ?? 0) >= config.clustering.threshold &&
    minimum >=
      config.clustering.threshold * config.clustering.completeLinkRatio;
  return {
    accepted,
    average,
    reasons: accepted
      ? unique(similarities.flatMap(({ reasons }) => reasons))
      : [],
  };
}

function buildCluster(
  runId: string,
  working: WorkingCluster,
  config: RankingConfig,
  now: Date,
): StoryCluster {
  const items = working.members.map(({ item }) => item);
  const representative = chooseRepresentative(working.members);
  const combined = extractFeatures(
    representative.featured.item.title,
    items.map(({ summary }) => summary).join(" "),
    config,
  );
  const sourceItemIds = items.map(({ id }) => id).sort();
  const id = `cluster_${hash(sourceItemIds.join("\0")).slice(0, 24)}`;
  const published = items
    .map(({ publishedAt }) => publishedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const signalTimes = items
    .map(({ publishedAt, retrievedAt }) => publishedAt ?? retrievedAt)
    .sort();
  const primarySourceItemIds = items
    .filter(({ authority }) => authority === "primary")
    .map(({ id: itemId }) => itemId)
    .sort();
  const fingerprint = createFingerprint(
    combined.entities,
    combined.productIdentifiers,
    combined.eventKeywords,
    published.at(0) ?? signalTimes[0] ?? now.toISOString(),
    items
      .filter(({ authority }) => authority === "primary")
      .map(({ canonicalUrl }) => canonicalUrl),
  );

  return storyClusterSchema.parse({
    id,
    runId,
    representativeTitle: representative.featured.item.title,
    representativeTitleReason: representative.reason,
    normalizedTitle: representative.featured.features.normalizedTitle,
    summary: chooseSummary(items),
    sourceItemIds,
    sourceIds: unique(items.map(({ sourceId }) => sourceId)).sort(),
    primarySourceItemIds,
    authorityCounts: {
      primary: items.filter(({ authority }) => authority === "primary").length,
      independent: items.filter(({ authority }) => authority === "independent")
        .length,
      community: items.filter(({ authority }) => authority === "community")
        .length,
      aggregator: items.filter(({ authority }) => authority === "aggregator")
        .length,
    },
    categories: unique(items.flatMap(({ categories }) => categories)).sort(),
    keywords: combined.keywords,
    entities: combined.entities,
    productIdentifiers: combined.productIdentifiers,
    eventKeywords: combined.eventKeywords,
    firstSeenAt: signalTimes[0] ?? now.toISOString(),
    latestSignalAt: signalTimes.at(-1) ?? now.toISOString(),
    publishedAtEarliest: published[0],
    publishedAtLatest: published.at(-1),
    sourceCount: unique(items.map(({ sourceId }) => sourceId)).length,
    independentSourceCount: independentPublisherCount(items, config),
    discussionSignals: discussionSignals(items, now),
    clusterConfidence: clusterConfidence(working.members, config),
    clusterReasons: unique([
      representative.reason,
      ...working.edgeReasons,
      working.members.length === 1
        ? "single source item; no merge inferred"
        : "complete-link safeguard passed",
    ]),
    fingerprint,
    status: "active",
  });
}

function chooseRepresentative(members: readonly FeaturedItem[]): {
  featured: FeaturedItem;
  reason: string;
} {
  const ranked = members
    .map((featured, index) => ({
      featured,
      index,
      quality: titleQuality(featured.item.title),
    }))
    .sort((left, right) => {
      const authority =
        authorityRank(right.featured.item.authority) -
        authorityRank(left.featured.item.authority);
      if (authority !== 0) return authority;
      if (right.quality !== left.quality) return right.quality - left.quality;
      const time =
        Date.parse(
          left.featured.item.publishedAt ?? left.featured.item.retrievedAt,
        ) -
        Date.parse(
          right.featured.item.publishedAt ?? right.featured.item.retrievedAt,
        );
      return time || left.index - right.index;
    });
  const featured = ranked[0]?.featured;
  if (!featured)
    throw new Error("Cannot select a representative from an empty cluster");
  const reason =
    featured.item.authority === "primary"
      ? "selected primary-source title"
      : `selected highest-quality ${featured.item.authority} title`;
  return { featured, reason };
}

function titleQuality(title: string): number {
  let score = Math.min(30, title.length) / 30;
  if (title === title.toUpperCase() && /[A-Z]/.test(title)) score -= 0.5;
  if (/\?\s*$/.test(title)) score -= 0.2;
  if (/!{2,}|\?{2,}/.test(title)) score -= 0.3;
  if (/\.\.\.$/.test(title) || title.length < 20) score -= 0.2;
  return score;
}

function independentPublisherCount(
  items: readonly SourceItem[],
  config: RankingConfig,
): number {
  const publishers = new Set<string>();
  for (const item of items) {
    if (item.authority !== "primary" && item.authority !== "independent")
      continue;
    publishers.add(
      config.publisherGroups[item.sourceId] ??
        `${item.sourceName.toLowerCase()}@${new URL(item.canonicalUrl).hostname}`,
    );
  }
  return publishers.size;
}

function discussionSignals(
  items: readonly SourceItem[],
  now: Date,
): DiscussionSignal[] {
  return items
    .filter(({ sourceType }) => sourceType === "hacker-news")
    .map((item) => {
      const score = numericMetadata(item.rawMetadata.score);
      const comments = numericMetadata(item.rawMetadata.descendants);
      const ageHours = Math.max(
        0,
        (now.getTime() - Date.parse(item.publishedAt ?? item.retrievedAt)) /
          3_600_000,
      );
      const activity = Math.min(1, (score + comments * 2) / 400);
      return {
        provider: "hacker-news",
        sourceItemId: item.id,
        score,
        comments,
        ageHours: round(ageHours),
        normalizedVelocity: round(activity * Math.max(0.1, 1 - ageHours / 168)),
      };
    });
}

function clusterConfidence(
  members: readonly FeaturedItem[],
  config: RankingConfig,
): number {
  if (members.length === 1) return 0.5;
  const similarities: SimilarityResult[] = [];
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      const leftMember = members[left];
      const rightMember = members[right];
      if (leftMember && rightMember) {
        similarities.push(calculateSimilarity(leftMember, rightMember, config));
      }
    }
  }
  return round(averageOf(similarities.map(({ score }) => score)));
}

export function createFingerprint(
  entities: readonly string[],
  productIdentifiers: readonly string[],
  eventKeywords: readonly string[],
  date: string,
  primaryUrls: readonly string[],
): string {
  const dateBucket = date.slice(0, 10);
  return hash(
    JSON.stringify({
      entities: [...entities].sort(),
      productIdentifiers: [...productIdentifiers].sort(),
      eventKeywords: [...eventKeywords].sort(),
      dateBucket,
      primaryUrls: [...primaryUrls].sort(),
    }),
  );
}

function chooseSummary(items: readonly SourceItem[]): string {
  return (
    [...items]
      .map(({ summary }) => summary)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? ""
  );
}

function authorityRank(authority: SourceItem["authority"]): number {
  return { primary: 4, independent: 3, aggregator: 2, community: 1 }[authority];
}

function numericMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function averageOf(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
