import { z } from "zod";

import { sourceAuthoritySchema } from "../discovery/models/source-item";

export const discussionSignalSchema = z.object({
  provider: z.string(),
  sourceItemId: z.string(),
  score: z.number().nonnegative(),
  comments: z.number().nonnegative(),
  ageHours: z.number().nonnegative(),
  normalizedVelocity: z.number().min(0).max(1),
});

const authorityCountsSchema = z.record(
  sourceAuthoritySchema,
  z.number().int().nonnegative(),
);

export const storyClusterSchema = z.object({
  id: z.string().regex(/^cluster_[a-f0-9]{24}$/),
  runId: z.string(),
  representativeTitle: z.string().min(1),
  representativeTitleReason: z.string().min(1),
  normalizedTitle: z.string().min(1),
  summary: z.string(),
  sourceItemIds: z.array(z.string()).min(1),
  sourceIds: z.array(z.string()).min(1),
  primarySourceItemIds: z.array(z.string()),
  authorityCounts: authorityCountsSchema,
  categories: z.array(z.string()),
  keywords: z.array(z.string()),
  entities: z.array(z.string()),
  productIdentifiers: z.array(z.string()),
  eventKeywords: z.array(z.string()),
  firstSeenAt: z.string().datetime({ offset: true }),
  latestSignalAt: z.string().datetime({ offset: true }),
  publishedAtEarliest: z.string().datetime({ offset: true }).optional(),
  publishedAtLatest: z.string().datetime({ offset: true }).optional(),
  sourceCount: z.number().int().positive(),
  independentSourceCount: z.number().int().nonnegative(),
  discussionSignals: z.array(discussionSignalSchema),
  clusterConfidence: z.number().min(0).max(1),
  clusterReasons: z.array(z.string()),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["active", "suppressed", "rejected", "expired"]),
});

export const scoreBreakdownSchema = z.object({
  freshness: z.number().nonnegative(),
  primarySource: z.number().nonnegative(),
  sourceDiversity: z.number().nonnegative(),
  discussionVelocity: z.number().nonnegative(),
  audienceRelevance: z.number().nonnegative(),
  analysisPotential: z.number().nonnegative(),
  searchShelfLife: z.number().nonnegative(),
  originalAngle: z.number().nonnegative(),
});

export const penaltiesSchema = z.object({
  rumorRisk: z.number().max(0),
  recentCoverage: z.number().max(0),
  weakEvidence: z.number().max(0),
  saturation: z.number().max(0),
  staleTopic: z.number().max(0),
  singleSource: z.number().max(0),
});

export const topicCandidateSchema = z.object({
  id: z.string().regex(/^topic_[a-f0-9]{24}$/),
  clusterId: z.string(),
  runId: z.string(),
  title: z.string().min(1),
  summary: z.string(),
  recommendedAngle: z.string().min(1),
  categories: z.array(z.string()),
  keywords: z.array(z.string()),
  entities: z.array(z.string()),
  sourceItemIds: z.array(z.string()).min(1),
  primarySourceItemIds: z.array(z.string()),
  firstSeenAt: z.string().datetime({ offset: true }),
  latestSignalAt: z.string().datetime({ offset: true }),
  score: z.number().min(0).max(100),
  scoreBreakdown: scoreBreakdownSchema,
  penalties: penaltiesSchema,
  risks: z.array(z.string()),
  selectionReasons: z.array(z.string()),
  rejectionReasons: z.array(z.string()),
  estimatedShelfLife: z.enum(["hours", "days", "weeks", "months", "evergreen"]),
  evidenceStrength: z.enum(["strong", "moderate", "weak", "insufficient"]),
  status: z.enum(["pending", "approved", "rejected", "suppressed", "expired"]),
  createdAt: z.string().datetime({ offset: true }),
  clusterFingerprint: z.string(),
});

export type DiscussionSignal = z.infer<typeof discussionSignalSchema>;
export type StoryCluster = z.infer<typeof storyClusterSchema>;
export type TopicCandidate = z.infer<typeof topicCandidateSchema>;

export const historyEntrySchema = z.object({
  id: z.string(),
  status: z.enum(["recommended", "approved", "rejected", "published"]),
  title: z.string(),
  entities: z.array(z.string()),
  keywords: z.array(z.string()),
  productIdentifiers: z.array(z.string()).default([]),
  eventKeywords: z.array(z.string()).default([]),
  clusterFingerprint: z.string(),
  date: z.string().datetime({ offset: true }),
  articleSlug: z.string().optional(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;
