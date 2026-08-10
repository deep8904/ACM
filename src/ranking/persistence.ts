import { z } from "zod";

import type { StoryCluster, TopicCandidate } from "./models";

export const aiRankingPacketItemSchema = z.object({
  candidateId: z.string(),
  title: z.string(),
  summary: z.string(),
  score: z.number(),
  scoreBreakdown: z.record(z.string(), z.number()),
  entities: z.array(z.string()),
  sourceCount: z.number().int(),
  primarySourceCount: z.number().int(),
  evidenceStrength: z.string(),
  risks: z.array(z.string()),
  recommendedAngle: z.string(),
  estimatedShelfLife: z.string(),
});

export const rankingReportSchema = z.object({
  runId: z.string(),
  stage: z.literal("RANKED"),
  createdAt: z.string().datetime({ offset: true }),
  inputItemCount: z.number().int().nonnegative(),
  clusterCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative(),
  suppressedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  scoreDistribution: z.record(z.string(), z.number().int().nonnegative()),
  topCandidateExplanations: z.array(
    z.object({
      candidateId: z.string(),
      score: z.number(),
      reasons: z.array(z.string()),
    }),
  ),
  penaltySummaries: z.record(z.string(), z.number()),
  clusterConfidenceSummary: z.object({
    low: z.number(),
    medium: z.number(),
    high: z.number(),
  }),
  processingDurationsMs: z.object({
    clustering: z.number(),
    scoring: z.number(),
    total: z.number(),
  }),
  warnings: z.array(z.string()),
});

export type RankingReport = z.infer<typeof rankingReportSchema>;
export type AiRankingPacketItem = z.infer<typeof aiRankingPacketItemSchema>;

export interface RankingArtifacts {
  clusters: StoryCluster[];
  candidates: TopicCandidate[];
  ranked: TopicCandidate[];
  suppressed: TopicCandidate[];
  report: RankingReport;
  aiPacket: AiRankingPacketItem[];
}
