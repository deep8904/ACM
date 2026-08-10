import { sha256 } from "../writing/task";
import type { AnalyticsConfig } from "./config";
import {
  dataCompletenessSchema,
  derivedMetricsSchema,
  editorialInsightSchema,
  type ArticleMetrics,
  type DataCompleteness,
  type EditorialInsight,
  type PerformanceSnapshot,
  type SocialMetrics,
} from "./models";

const ratio = (a: number | null, b: number | null) =>
  a === null || b === null || b === 0 ? null : a / b;
const sumKnown = (values: Array<number | null>) => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
};
export function median(values: Array<number | null>) {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function dataQuality(input: {
  available: number;
  total: number;
  providerCoverage: number;
  dateCoverage: number;
  mappingConfidence: number;
  stale?: boolean;
  partialWindow?: boolean;
  conflicts?: string[];
  config: AnalyticsConfig;
}): DataCompleteness {
  const metricCoverage = input.total ? input.available / input.total : 0;
  const score =
    metricCoverage * 0.4 +
    input.providerCoverage * 0.25 +
    input.dateCoverage * 0.2 +
    input.mappingConfidence * 0.15 -
    (input.stale ? 0.15 : 0) -
    ((input.conflicts?.length ?? 0) ? 0.15 : 0);
  const bounded = Math.max(0, Math.min(1, score));
  const label =
    bounded >= input.config.qualityThresholds.high
      ? "high"
      : bounded >= input.config.qualityThresholds.moderate
        ? "moderate"
        : bounded >= input.config.qualityThresholds.low
          ? "low"
          : "insufficient";
  return dataCompletenessSchema.parse({
    label,
    score: bounded,
    providerCoverage: input.providerCoverage,
    dateCoverage: input.dateCoverage,
    mappingConfidence: input.mappingConfidence,
    metricStates: {},
    stale: input.stale ?? false,
    partialWindow: input.partialWindow ?? false,
    conflicts: input.conflicts ?? [],
    warnings: [
      ...(input.partialWindow ? ["Metric window is incomplete"] : []),
      ...(input.stale ? ["Metrics may be stale"] : []),
    ],
  });
}
export function deriveMetrics(
  article: ArticleMetrics[],
  social: SocialMetrics[],
  periodDays: number | null,
) {
  const searchClicks = sumKnown(article.map((value) => value.searchClicks));
  const searchImpressions = sumKnown(
    article.map((value) => value.searchImpressions),
  );
  const siteClicks = sumKnown(article.map((value) => value.clicks));
  const pageViews = sumKnown(article.map((value) => value.pageViews));
  const socialClicks = sumKnown(social.map((value) => value.clicks));
  const socialImpressions = sumKnown(
    social.map((value) => value.impressions ?? value.views ?? value.reach),
  );
  const socialEngagements = sumKnown(
    social.map((value) =>
      sumKnown([
        value.likes,
        value.reactions,
        value.comments,
        value.shares,
        value.reposts,
        value.saves,
      ]),
    ),
  );
  const traffic = article[0]?.sourceBreakdown;
  const trafficTotal = traffic
    ? Object.values(traffic).reduce((sum, value) => sum + value, 0)
    : null;
  const maxTraffic = traffic ? Math.max(0, ...Object.values(traffic)) : null;
  const operational = article.find((value) => value.operational)?.operational;
  const availableComponents = [searchClicks, pageViews, socialClicks].filter(
    (value) => value !== null,
  );
  const performanceIndex =
    availableComponents.length >= 2
      ? {
          score: Math.min(
            100,
            Math.round(
              availableComponents.reduce(
                (sum, value) => sum + Math.log10(value + 1) * 12,
                0,
              ) / availableComponents.length,
            ),
          ),
          componentsUsed: [
            searchClicks !== null ? "search" : "",
            pageViews !== null ? "site_traffic" : "",
            socialClicks !== null ? "social" : "",
          ].filter(Boolean),
          componentsOmitted: [
            searchClicks === null ? "search" : "",
            pageViews === null ? "site_traffic" : "",
            socialClicks === null ? "social" : "",
          ].filter(Boolean),
          baseline:
            "log-scaled available components; compare only within equivalent windows",
          confidence: availableComponents.length === 3 ? "moderate" : "low",
        }
      : null;
  return derivedMetricsSchema.parse({
    searchCtr: ratio(searchClicks, searchImpressions),
    socialClickThroughRate: ratio(socialClicks, socialImpressions),
    engagementRate: ratio(socialEngagements, socialImpressions),
    viewsPerDay:
      periodDays && pageViews !== null ? pageViews / periodDays : null,
    clicksPerDay:
      periodDays && siteClicks !== null ? siteClicks / periodDays : null,
    impressionsPerDay:
      periodDays && searchImpressions !== null
        ? searchImpressions / periodDays
        : null,
    searchGrowthRate: null,
    trafficSourceConcentration: ratio(maxTraffic, trafficTotal),
    socialToSiteClickRatio: ratio(socialClicks, siteClicks),
    publicationVelocity: null,
    editorialCycleSeconds: operational?.editorialCycleSeconds ?? null,
    revisionCount: operational?.reviewIterations ?? null,
    sourceDiversity: operational?.sourceCount ?? null,
    searchLongevity: null,
    distributionCompletionRate: operational?.distributionCompletionRate ?? null,
    performanceIndex,
  });
}

export function buildInsights(
  snapshots: PerformanceSnapshot[],
  config: AnalyticsConfig,
  now: string,
): EditorialInsight[] {
  const complete = snapshots.filter(
    (snapshot) =>
      !snapshot.articleMetrics.some(
        (metric) => metric.dataCompleteness.partialWindow,
      ),
  );
  const values = complete
    .map((snapshot) => ({
      publicationId: snapshot.publicationId,
      clicks: snapshot.derivedMetrics.searchCtr,
      type: snapshot.articleMetrics[0]?.operational?.articleType,
      quality:
        snapshot.articleMetrics[0]?.dataCompleteness.label ?? "insufficient",
    }))
    .filter((value) => value.clicks !== null);
  if (values.length < config.minimumSampleSize)
    return [
      editorialInsightSchema.parse({
        id: `insight_${sha256("insufficient-data").slice(0, 24)}`,
        category: "data_quality",
        scope: "all_publications",
        title: "More comparable data is required",
        observation: `Only ${values.length} complete comparable snapshots have search CTR data.`,
        evidence: [`Minimum configured sample: ${config.minimumSampleSize}`],
        confidence: "insufficient",
        sampleSize: values.length,
        recommendedAction:
          "Continue aggregate collection without changing editorial or ranking configuration.",
        limitations: ["Missing and partial data are excluded from baselines."],
        status: "insufficient_data",
        dataQuality: "insufficient",
        suggestedChange: null,
        experiment: null,
        createdAt: now,
        version: 1,
      }),
    ];
  const baseline = median(values.map((value) => value.clicks));
  const byType = new Map<string, number[]>();
  for (const value of values) {
    if (!value.type || value.clicks === null) continue;
    byType.set(value.type, [...(byType.get(value.type) ?? []), value.clicks]);
  }
  const strongest = [...byType.entries()]
    .filter(([, group]) => group.length >= config.minimumSampleSize)
    .map(([type, group]) => ({ type, group, value: median(group) }))
    .filter((value) => value.value !== null)
    .sort((a, b) => b.value! - a.value!)[0];
  if (!strongest || baseline === null)
    return buildInsights(
      [],
      { ...config, minimumSampleSize: config.minimumSampleSize },
      now,
    );
  return [
    editorialInsightSchema.parse({
      id: `insight_${sha256(`${strongest.type}:${strongest.value}:${baseline}`).slice(0, 24)}`,
      category: "article_type",
      scope: strongest.type,
      title: `${strongest.type} search CTR pattern`,
      observation: `${strongest.type} has a median search CTR of ${(strongest.value! * 100).toFixed(1)}% versus ${(baseline * 100).toFixed(1)}% across complete comparable snapshots.`,
      evidence: [
        `Metric: median search CTR`,
        `Period: equivalent snapshot windows`,
        `Difference: ${((strongest.value! - baseline) * 100).toFixed(1)} percentage points`,
      ],
      confidence:
        strongest.group.length >= config.minimumSampleSize * 2
          ? "moderate"
          : "low",
      sampleSize: strongest.group.length,
      recommendedAction: `Consider a manually reviewed experiment with additional ${strongest.type} coverage when evidence and reader value support it.`,
      limitations: [
        "Association does not establish causation.",
        "Provider coverage and topic demand may confound the result.",
      ],
      status: "review_recommended",
      dataQuality: values.every((value) => value.quality === "high")
        ? "high"
        : "moderate",
      suggestedChange: null,
      experiment: {
        hypothesis: `${strongest.type} maintains higher search CTR than the comparable portfolio median.`,
        metric: "28-day median search CTR",
        baseline: `${(baseline * 100).toFixed(1)}% portfolio median`,
        duration: "At least 90 days",
        minimumSampleSize: config.minimumSampleSize,
        variablesHeldConstant: [
          "Editorial quality gate",
          "Citation policy",
          "Distribution effort",
        ],
        stopCondition:
          "Stop if quality or disclosure requirements would be weakened.",
        ethicalConstraints: [
          "No clickbait",
          "No reduced fact-checking",
          "No publishing quota",
        ],
        status: "requires_manual_review",
      },
      createdAt: now,
      version: 1,
    }),
  ];
}
