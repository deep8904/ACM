import { z } from "zod";

import type { WorkflowArtifactRepository } from "../database/artifacts";
import { sourceItemSchema } from "../discovery/models/source-item";
import {
  log as defaultLog,
  type LogContext,
  type LogLevel,
} from "../lib/logger";
import { clusterStories } from "./clustering";
import type { RankingConfig } from "./config";
import { evaluateRecentCoverage, type HistoryRepository } from "./history";
import {
  storyClusterSchema,
  topicCandidateSchema,
  type StoryCluster,
  type TopicCandidate,
} from "./models";
import {
  aiRankingPacketItemSchema,
  rankingReportSchema,
  type AiRankingPacketItem,
  type RankingArtifacts,
  type RankingReport,
} from "./persistence";
import { scoreCluster } from "./scoring";

export interface RankingOptions {
  runId: string;
  config: RankingConfig;
  history: HistoryRepository;
  now?: () => Date;
  monotonicNow?: () => number;
  logger?: (level: LogLevel, message: string, context: LogContext) => void;
  artifactRepository: WorkflowArtifactRepository;
}

export interface RankingResult extends RankingArtifacts {
  outputDirectory: string;
}

export async function runRankingPipeline(
  options: RankingOptions,
): Promise<RankingResult> {
  const existing = await readRepositoryRankingArtifacts(
    options.artifactRepository,
    options.runId,
  );
  if (existing) {
    (options.logger ?? defaultLog)("info", "Ranking run reused", {
      runId: options.runId,
      stage: "RANKED",
    });
    return {
      ...existing,
      outputDirectory: options.artifactRepository.location(
        options.runId,
        "ranking",
      ),
    };
  }

  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const logger = options.logger ?? defaultLog;
  const started = monotonicNow();
  const items = await readInputItems(options);
  const currentTime = now();
  logger("info", "Ranking pipeline started", {
    runId: options.runId,
    stage: "RANKING",
  });

  const clusteringStarted = monotonicNow();
  let clusters = clusterStories(
    options.runId,
    items,
    options.config,
    currentTime,
  );
  const clusteringDuration = elapsed(monotonicNow(), clusteringStarted);
  const history = await options.history.list();
  const scoringStarted = monotonicNow();
  const candidates = clusters
    .map((cluster) => {
      const suppression = evaluateRecentCoverage(
        cluster,
        history,
        options.config,
        currentTime,
      );
      return scoreCluster(cluster, options.config, suppression, currentTime);
    })
    .sort(candidateOrder);
  const suppressedClusterIds = new Set(
    candidates
      .filter(({ status }) => status === "suppressed")
      .map(({ clusterId }) => clusterId),
  );
  clusters = clusters.map((cluster) =>
    suppressedClusterIds.has(cluster.id)
      ? storyClusterSchema.parse({ ...cluster, status: "suppressed" })
      : cluster,
  );
  const scoringDuration = elapsed(monotonicNow(), scoringStarted);
  const ranked = candidates
    .filter(({ status }) => status === "pending")
    .slice(0, options.config.output.maxRankedCandidates);
  const suppressed = candidates.filter(({ status }) => status === "suppressed");
  const aiPacket = prepareAiPacket(
    ranked,
    options.config.output.aiPacketSize,
    clusters,
  );
  const report = createReport(
    options.runId,
    items.length,
    clusters,
    candidates,
    ranked,
    suppressed,
    currentTime,
    clusteringDuration,
    scoringDuration,
    elapsed(monotonicNow(), started),
  );
  const artifacts = {
    clusters,
    candidates,
    ranked,
    suppressed,
    report,
    aiPacket,
  };
  await writeRepositoryRankingArtifacts(
    options.artifactRepository,
    options.runId,
    artifacts,
  );
  const outputDirectory = options.artifactRepository.location(
    options.runId,
    "ranking",
  );
  logger("info", "Ranking pipeline completed", {
    runId: options.runId,
    stage: "RANKED",
    durationMs: report.processingDurationsMs.total,
  });
  return { ...artifacts, outputDirectory };
}

const databaseRankingFiles = {
  clusters: "story-clusters.json",
  candidates: "topic-candidates.json",
  ranked: "ranked-topics.json",
  suppressed: "suppressed-topics.json",
  report: "ranking-report.json",
  aiPacket: "ai-ranking-packet.json",
} as const;

async function readInputItems(options: RankingOptions) {
  const artifact = await options.artifactRepository.get(
    options.runId,
    "discovery",
    "normalized-items.json",
  );
  if (!artifact)
    throw new Error(
      `Missing discovery artifact normalized-items.json for ${options.runId} in ${options.artifactRepository.location(options.runId, "discovery")}`,
    );
  return z.array(sourceItemSchema).parse(artifact.content);
}

async function readRepositoryRankingArtifacts(
  repository: WorkflowArtifactRepository,
  runId: string,
): Promise<RankingArtifacts | undefined> {
  const entries = await Promise.all(
    Object.values(databaseRankingFiles).map((name) =>
      repository.get(runId, "ranking", name),
    ),
  );
  if (entries.every((entry) => !entry)) return undefined;
  if (entries.some((entry) => !entry))
    throw new Error(`Incomplete durable ranking artifacts for ${runId}`);
  const values = entries.map((entry) => entry?.content);
  return {
    clusters: z.array(storyClusterSchema).parse(values[0]),
    candidates: z.array(topicCandidateSchema).parse(values[1]),
    ranked: z.array(topicCandidateSchema).parse(values[2]),
    suppressed: z.array(topicCandidateSchema).parse(values[3]),
    report: rankingReportSchema.parse(values[4]),
    aiPacket: z.array(aiRankingPacketItemSchema).parse(values[5]),
  };
}

async function writeRepositoryRankingArtifacts(
  repository: WorkflowArtifactRepository,
  runId: string,
  artifacts: RankingArtifacts,
): Promise<void> {
  await Promise.all(
    (Object.keys(databaseRankingFiles) as (keyof RankingArtifacts)[]).map(
      (key) =>
        repository.save({
          runId,
          stage: "ranking",
          name: databaseRankingFiles[key],
          mediaType: "application/json",
          content: artifacts[key],
        }),
    ),
  );
}

function prepareAiPacket(
  candidates: readonly TopicCandidate[],
  limit: number,
  clusters: readonly StoryCluster[],
): AiRankingPacketItem[] {
  const clusterIndex = new Map(
    clusters.map((cluster) => [cluster.id, cluster]),
  );
  return candidates.slice(0, limit).map((candidate) => {
    const cluster = clusterIndex.get(candidate.clusterId);
    if (!cluster) throw new Error(`Missing cluster ${candidate.clusterId}`);
    return {
      candidateId: candidate.id,
      title: candidate.title,
      summary: candidate.summary.slice(0, 500),
      score: candidate.score,
      scoreBreakdown: candidate.scoreBreakdown,
      entities: candidate.entities,
      sourceCount: cluster.sourceCount,
      primarySourceCount: candidate.primarySourceItemIds.length,
      evidenceStrength: candidate.evidenceStrength,
      risks: candidate.risks,
      recommendedAngle: candidate.recommendedAngle,
      estimatedShelfLife: candidate.estimatedShelfLife,
    };
  });
}

function createReport(
  runId: string,
  inputItemCount: number,
  clusters: readonly StoryCluster[],
  candidates: readonly TopicCandidate[],
  ranked: readonly TopicCandidate[],
  suppressed: readonly TopicCandidate[],
  now: Date,
  clustering: number,
  scoring: number,
  total: number,
): RankingReport {
  const penaltyNames = Object.keys(
    candidates[0]?.penalties ?? {},
  ) as (keyof TopicCandidate["penalties"])[];
  return {
    runId,
    stage: "RANKED",
    createdAt: now.toISOString(),
    inputItemCount,
    clusterCount: clusters.length,
    candidateCount: candidates.length,
    eligibleCount: ranked.length,
    suppressedCount: suppressed.length,
    rejectedCount: candidates.filter(({ status }) => status === "rejected")
      .length,
    scoreDistribution: {
      "0-24": candidates.filter(({ score }) => score < 25).length,
      "25-49": candidates.filter(({ score }) => score >= 25 && score < 50)
        .length,
      "50-74": candidates.filter(({ score }) => score >= 50 && score < 75)
        .length,
      "75-100": candidates.filter(({ score }) => score >= 75).length,
    },
    topCandidateExplanations: ranked.slice(0, 5).map((candidate) => ({
      candidateId: candidate.id,
      score: candidate.score,
      reasons: candidate.selectionReasons,
    })),
    penaltySummaries: Object.fromEntries(
      penaltyNames.map((name) => [
        name,
        round(
          candidates.reduce(
            (sum, candidate) => sum + candidate.penalties[name],
            0,
          ),
        ),
      ]),
    ),
    clusterConfidenceSummary: {
      low: clusters.filter(({ clusterConfidence }) => clusterConfidence < 0.6)
        .length,
      medium: clusters.filter(
        ({ clusterConfidence }) =>
          clusterConfidence >= 0.6 && clusterConfidence < 0.8,
      ).length,
      high: clusters.filter(({ clusterConfidence }) => clusterConfidence >= 0.8)
        .length,
    },
    processingDurationsMs: { clustering, scoring, total },
    warnings: candidates
      .filter(({ evidenceStrength }) => evidenceStrength === "insufficient")
      .map(({ id }) => `${id} has insufficient evidence`),
  };
}

function candidateOrder(left: TopicCandidate, right: TopicCandidate): number {
  return (
    right.score - left.score ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

function elapsed(end: number, start: number): number {
  return Math.max(0, Math.round(end - start));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
