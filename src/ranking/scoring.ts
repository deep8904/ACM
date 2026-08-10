import { createHash } from "node:crypto";

import type { RankingConfig } from "./config";
import type { SuppressionDecision } from "./history";
import {
  topicCandidateSchema,
  type StoryCluster,
  type TopicCandidate,
} from "./models";

export function scoreCluster(
  cluster: StoryCluster,
  config: RankingConfig,
  suppression: SuppressionDecision,
  now: Date,
): TopicCandidate {
  const evidenceStrength = calculateEvidenceStrength(cluster, config);
  const estimatedShelfLife = estimateShelfLife(cluster, config);
  const scoreBreakdown = {
    freshness: freshnessScore(cluster, config, now),
    primarySource:
      cluster.primarySourceItemIds.length > 0
        ? config.scoring.positive.primarySource
        : 0,
    sourceDiversity: round(
      Math.min(1, cluster.independentSourceCount / 3) *
        config.scoring.positive.sourceDiversity,
    ),
    discussionVelocity: round(
      Math.min(
        1,
        cluster.discussionSignals.reduce(
          (sum, signal) => sum + signal.normalizedVelocity,
          0,
        ),
      ) * config.scoring.positive.discussionVelocity,
    ),
    audienceRelevance: audienceRelevanceScore(cluster, config),
    analysisPotential: analysisPotentialScore(cluster, config),
    searchShelfLife: shelfLifeScore(estimatedShelfLife, config),
    originalAngle: originalAngleScore(cluster, config),
  };
  const rumorMatches = matchPatterns(
    `${cluster.normalizedTitle} ${cluster.summary}`,
    config.rumorPatterns,
  );
  const latestAgeHours = Math.max(
    0,
    (now.getTime() - Date.parse(cluster.latestSignalAt)) / 3_600_000,
  );
  const penalties = {
    rumorRisk: -round(
      Math.min(1, rumorMatches.length / 2) * config.scoring.penalties.rumorRisk,
    ),
    recentCoverage: -suppression.penalty,
    weakEvidence: -weakEvidencePenalty(evidenceStrength, config),
    saturation: -round(
      cluster.sourceCount >= 4 && cluster.clusterConfidence > 0.82
        ? config.scoring.penalties.saturation * 0.5
        : 0,
    ),
    staleTopic: -round(
      latestAgeHours > 168
        ? Math.min(1, (latestAgeHours - 168) / 504) *
            config.scoring.penalties.staleTopic
        : 0,
    ),
    singleSource: -(cluster.sourceCount === 1
      ? config.scoring.penalties.singleSource
      : 0),
  };
  const positiveTotal = Object.values(scoreBreakdown).reduce(
    (sum, value) => sum + value,
    0,
  );
  const penaltyTotal = Object.values(penalties).reduce(
    (sum, value) => sum + value,
    0,
  );
  const score = round(clamp(positiveTotal + penaltyTotal, 0, 100));
  const risks = unique([
    ...rumorMatches.map((pattern) => `rumor language: ${pattern}`),
    ...(evidenceStrength === "insufficient"
      ? ["insufficient corroborating evidence"]
      : []),
    ...(cluster.primarySourceItemIds.length === 0 ? ["no primary source"] : []),
    ...(cluster.sourceCount === 1 ? ["single-source dependency"] : []),
  ]);
  const rejectionReasons = [
    ...(score < config.scoring.minimumEligibleScore
      ? [
          `score ${score} is below eligibility threshold ${config.scoring.minimumEligibleScore}`,
        ]
      : []),
    ...(evidenceStrength === "insufficient"
      ? ["evidence is insufficient"]
      : []),
    ...(suppression.suppress ? suppression.reasons : []),
  ];
  const status = suppression.suppress
    ? "suppressed"
    : score < config.scoring.minimumEligibleScore ||
        evidenceStrength === "insufficient"
      ? "rejected"
      : "pending";

  return topicCandidateSchema.parse({
    id: `topic_${createHash("sha256").update(cluster.id).digest("hex").slice(0, 24)}`,
    clusterId: cluster.id,
    runId: cluster.runId,
    title: cluster.representativeTitle,
    summary: cluster.summary,
    recommendedAngle: deterministicAngle(cluster),
    categories: cluster.categories,
    keywords: cluster.keywords,
    entities: cluster.entities,
    sourceItemIds: cluster.sourceItemIds,
    primarySourceItemIds: cluster.primarySourceItemIds,
    firstSeenAt: cluster.firstSeenAt,
    latestSignalAt: cluster.latestSignalAt,
    score,
    scoreBreakdown,
    penalties,
    risks,
    selectionReasons: selectionReasons(scoreBreakdown, cluster, suppression),
    rejectionReasons,
    estimatedShelfLife,
    evidenceStrength,
    status,
    createdAt: now.toISOString(),
    clusterFingerprint: cluster.fingerprint,
  });
}

export function calculateEvidenceStrength(
  cluster: StoryCluster,
  config: RankingConfig,
): TopicCandidate["evidenceStrength"] {
  const rumorCount = matchPatterns(
    `${cluster.normalizedTitle} ${cluster.summary}`,
    config.rumorPatterns,
  ).length;
  let strength: TopicCandidate["evidenceStrength"];
  if (
    cluster.primarySourceItemIds.length > 0 &&
    cluster.independentSourceCount >= 2
  ) {
    strength = "strong";
  } else if (
    cluster.primarySourceItemIds.length > 0 ||
    cluster.independentSourceCount >= 2
  ) {
    strength = "moderate";
  } else if (cluster.authorityCounts.independent > 0) {
    strength = "weak";
  } else {
    strength = "insufficient";
  }
  if (rumorCount > 0) return downgrade(strength);
  if (!cluster.publishedAtLatest) return downgrade(strength);
  return strength;
}

function freshnessScore(
  cluster: StoryCluster,
  config: RankingConfig,
  now: Date,
): number {
  const newestAge = Math.max(
    0,
    (now.getTime() - Date.parse(cluster.latestSignalAt)) / 3_600_000,
  );
  const newestFactor =
    newestAge <= 6
      ? 1
      : newestAge <= 24
        ? 0.85
        : newestAge <= 72
          ? 0.6
          : newestAge <= 168
            ? 0.35
            : 0.1;
  const primaryFactor = cluster.primarySourceItemIds.length > 0 ? 1 : 0.55;
  const spread =
    cluster.publishedAtEarliest && cluster.publishedAtLatest
      ? (Date.parse(cluster.publishedAtLatest) -
          Date.parse(cluster.publishedAtEarliest)) /
        3_600_000
      : 72;
  const consistency = spread <= 24 ? 1 : spread <= 72 ? 0.85 : 0.65;
  return round(
    config.scoring.positive.freshness *
      (newestFactor * 0.65 + primaryFactor * 0.2 + consistency * 0.15),
  );
}

function audienceRelevanceScore(
  cluster: StoryCluster,
  config: RankingConfig,
): number {
  const terms = new Set(
    [...cluster.categories, ...cluster.keywords, ...cluster.entities].map(
      (value) => value.toLocaleLowerCase("en"),
    ),
  );
  const matched = Object.entries(config.relevanceWeights).reduce(
    (sum, [term, weight]) =>
      [...terms].some((value) => value.includes(term.toLocaleLowerCase("en")))
        ? sum + weight
        : sum,
    0,
  );
  return round(
    Math.min(1, matched / 10) * config.scoring.positive.audienceRelevance,
  );
}

function analysisPotentialScore(
  cluster: StoryCluster,
  config: RankingConfig,
): number {
  const signals =
    Math.min(1, cluster.eventKeywords.length / 2) * 0.35 +
    Math.min(1, cluster.sourceCount / 3) * 0.3 +
    (cluster.summary.length >= 80 ? 0.2 : 0.1) +
    (cluster.categories.length > 0 ? 0.15 : 0);
  return round(
    Math.min(1, signals) * config.scoring.positive.analysisPotential,
  );
}

function originalAngleScore(
  cluster: StoryCluster,
  config: RankingConfig,
): number {
  const practical =
    /(developer|designer|creator|buyer|workflow|tradeoff|compare|upgrade|limitation)/i.test(
      `${cluster.summary} ${cluster.keywords.join(" ")}`,
    );
  const factor = Math.min(
    1,
    0.2 +
      (practical ? 0.35 : 0) +
      (cluster.sourceCount >= 2 ? 0.25 : 0) +
      (cluster.productIdentifiers.length > 0 ? 0.2 : 0),
  );
  return round(factor * config.scoring.positive.originalAngle);
}

function estimateShelfLife(
  cluster: StoryCluster,
  config: RankingConfig,
): TopicCandidate["estimatedShelfLife"] {
  const text = `${cluster.normalizedTitle} ${cluster.summary}`;
  if (matchPatterns(text, config.rumorPatterns).length > 0) return "hours";
  if (/(guide|tutorial|reference|how to|explained)/i.test(text))
    return "evergreen";
  if (/(hardware|keyboard|monitor|laptop|camera|rtx)/i.test(text))
    return "months";
  if (/(release|launch|update|version|api)/i.test(text)) return "weeks";
  return "days";
}

function shelfLifeScore(
  shelfLife: TopicCandidate["estimatedShelfLife"],
  config: RankingConfig,
): number {
  const factor = {
    hours: 0.25,
    days: 0.5,
    weeks: 0.75,
    months: 0.9,
    evergreen: 1,
  }[shelfLife];
  return round(factor * config.scoring.positive.searchShelfLife);
}

function weakEvidencePenalty(
  strength: TopicCandidate["evidenceStrength"],
  config: RankingConfig,
): number {
  return round(
    { strong: 0, moderate: 0.2, weak: 0.6, insufficient: 1 }[strength] *
      config.scoring.penalties.weakEvidence,
  );
}

function deterministicAngle(cluster: StoryCluster): string {
  const audience = cluster.categories.includes("design")
    ? "design teams"
    : cluster.categories.includes("gaming")
      ? "players and game developers"
      : "developers and technical readers";
  return `Explain what changed, why it matters to ${audience}, and the practical tradeoffs.`;
}

function selectionReasons(
  breakdown: TopicCandidate["scoreBreakdown"],
  cluster: StoryCluster,
  suppression: SuppressionDecision,
): string[] {
  return unique([
    ...(breakdown.freshness >= 14 ? ["fresh signal"] : []),
    ...(cluster.primarySourceItemIds.length > 0
      ? ["primary source present"]
      : []),
    ...(cluster.independentSourceCount >= 2
      ? ["independent confirmation"]
      : []),
    ...(breakdown.discussionVelocity >= 8
      ? ["strong discussion velocity"]
      : []),
    ...suppression.reasons.filter(() => suppression.meaningfulUpdateOverride),
  ]);
}

function matchPatterns(text: string, patterns: readonly string[]): string[] {
  const normalized = text.toLocaleLowerCase("en");
  return patterns.filter((pattern) =>
    normalized.includes(pattern.toLocaleLowerCase("en")),
  );
}

function downgrade(
  strength: TopicCandidate["evidenceStrength"],
): TopicCandidate["evidenceStrength"] {
  return {
    strong: "moderate",
    moderate: "weak",
    weak: "insufficient",
    insufficient: "insufficient",
  }[strength] as TopicCandidate["evidenceStrength"];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
