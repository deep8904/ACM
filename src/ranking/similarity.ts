import type { SourceItem } from "../discovery/models/source-item";
import type { RankingConfig } from "./config";
import { extractFeatures, type ExtractedFeatures } from "./features";

export interface SimilarityResult {
  score: number;
  reasons: string[];
}

export interface FeaturedItem {
  item: SourceItem;
  features: ExtractedFeatures;
}

export function featureItem(
  item: SourceItem,
  config: RankingConfig,
): FeaturedItem {
  return { item, features: extractFeatures(item.title, item.summary, config) };
}

export function calculateSimilarity(
  left: FeaturedItem,
  right: FeaturedItem,
  config: RankingConfig,
): SimilarityResult {
  const hours = timeDistanceHours(left.item, right.item);
  if (hours > config.clustering.maxComparisonHours) {
    return {
      score: 0,
      reasons: [`signals separated by ${Math.round(hours)} hours`],
    };
  }

  const titleOverlap = jaccard(
    left.features.titleTokens,
    right.features.titleTokens,
  );
  const keywordOverlap = weightedOverlap(
    left.features.keywords,
    right.features.keywords,
  );
  const entityOverlap = jaccard(
    left.features.entities,
    right.features.entities,
  );
  const identifierOverlap = jaccard(
    left.features.productIdentifiers,
    right.features.productIdentifiers,
  );
  const leftEvents = normalizeEventGroups(left.features.eventKeywords, config);
  const rightEvents = normalizeEventGroups(
    right.features.eventKeywords,
    config,
  );
  const eventOverlap = jaccard(leftEvents, rightEvents);
  const summaryOverlap = jaccard(
    left.features.summaryTokens,
    right.features.summaryTokens,
  );
  const timeScore = Math.max(
    0,
    1 - hours / config.clustering.maxComparisonHours,
  );
  let score =
    titleOverlap * 0.34 +
    keywordOverlap * 0.16 +
    entityOverlap * 0.14 +
    identifierOverlap * 0.18 +
    eventOverlap * 0.1 +
    summaryOverlap * 0.03 +
    timeScore * 0.05;
  const reasons: string[] = [];

  if (titleOverlap > 0)
    reasons.push(`title token overlap: ${titleOverlap.toFixed(2)}`);
  for (const entity of intersection(
    left.features.entities,
    right.features.entities,
  )) {
    reasons.push(`shared entity: ${entity}`);
  }
  for (const identifier of intersection(
    left.features.productIdentifiers,
    right.features.productIdentifiers,
  )) {
    reasons.push(`shared product identifier: ${identifier}`);
  }
  if (hours <= 24)
    reasons.push(`published within ${Math.max(1, Math.round(hours))} hours`);

  const bothHaveIdentifiers =
    left.features.productIdentifiers.length > 0 &&
    right.features.productIdentifiers.length > 0;
  if (bothHaveIdentifiers && identifierOverlap === 0) {
    score = Math.min(score, 0.35);
    reasons.push("different product identifiers prevent merge");
  }
  if (
    leftEvents.length > 0 &&
    rightEvents.length > 0 &&
    eventOverlap === 0 &&
    titleOverlap < 0.5
  ) {
    score = Math.min(score, 0.4);
    reasons.push("different event types prevent merge");
  }
  if (
    entityOverlap > 0 &&
    identifierOverlap === 0 &&
    eventOverlap === 0 &&
    titleOverlap < 0.35
  ) {
    score = Math.min(score, 0.42);
    reasons.push("shared entity without a shared event is insufficient");
  }
  if (opinionMismatch(left, right) && eventOverlap < 0.5) {
    score = Math.min(score, 0.45);
    reasons.push("opinion and announcement framing differ");
  }

  return { score: round(Math.min(1, score)), reasons };
}

function normalizeEventGroups(
  events: readonly string[],
  config: RankingConfig,
): string[] {
  return [
    ...new Set(
      events.map((event) => {
        for (const [group, members] of Object.entries(config.eventGroups)) {
          if (members.includes(event)) return group;
        }
        return event;
      }),
    ),
  ];
}

function timeDistanceHours(left: SourceItem, right: SourceItem): number {
  const leftTime = Date.parse(left.publishedAt ?? left.retrievedAt);
  const rightTime = Date.parse(right.publishedAt ?? right.retrievedAt);
  return Math.abs(leftTime - rightTime) / 3_600_000;
}

function opinionMismatch(left: FeaturedItem, right: FeaturedItem): boolean {
  const markers = new Set(["opinion", "review", "why", "should", "think"]);
  const leftOpinion = left.features.titleTokens.some((token) =>
    markers.has(token),
  );
  const rightOpinion = right.features.titleTokens.some((token) =>
    markers.has(token),
  );
  return leftOpinion !== rightOpinion;
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const union = new Set([...left, ...right]);
  return intersection(left, right).length / union.size;
}

function weightedOverlap(
  left: readonly string[],
  right: readonly string[],
): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightIndex = new Map(right.map((value, index) => [value, index]));
  let shared = 0;
  let total = 0;
  left.forEach((value, index) => {
    const weight = 1 / (index + 1);
    total += weight;
    const otherIndex = rightIndex.get(value);
    if (otherIndex !== undefined)
      shared += Math.min(weight, 1 / (otherIndex + 1));
  });
  return total === 0 ? 0 : shared / total;
}

function intersection(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
