import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const entityRuleSchema = z.object({
  canonical: z.string().min(1),
  type: z.enum([
    "organization",
    "product",
    "language",
    "framework",
    "engine",
    "hardware",
  ]),
  aliases: z.array(z.string().min(1)).min(1),
});

const positiveWeightsSchema = z.object({
  freshness: z.number().nonnegative().default(20),
  primarySource: z.number().nonnegative().default(15),
  sourceDiversity: z.number().nonnegative().default(10),
  discussionVelocity: z.number().nonnegative().default(15),
  audienceRelevance: z.number().nonnegative().default(15),
  analysisPotential: z.number().nonnegative().default(10),
  searchShelfLife: z.number().nonnegative().default(10),
  originalAngle: z.number().nonnegative().default(5),
});

const penaltyWeightsSchema = z.object({
  rumorRisk: z.number().nonnegative().max(20).default(20),
  recentCoverage: z.number().nonnegative().max(25).default(25),
  weakEvidence: z.number().nonnegative().max(20).default(20),
  saturation: z.number().nonnegative().max(10).default(10),
  staleTopic: z.number().nonnegative().max(20).default(10),
  singleSource: z.number().nonnegative().max(20).default(8),
});

export const rankingConfigSchema = z
  .object({
    clustering: z
      .object({
        threshold: z.number().min(0.4).max(0.95).default(0.64),
        completeLinkRatio: z.number().min(0.7).max(1).default(0.9),
        lookbackHours: z.number().int().min(24).max(2160).default(720),
        maxComparisonHours: z.number().int().min(1).max(720).default(168),
        keywordCount: z.number().int().min(3).max(30).default(12),
      })
      .prefault({}),
    output: z
      .object({
        maxRankedCandidates: z.number().int().min(1).max(100).default(20),
        aiPacketSize: z.number().int().min(1).max(20).default(20),
      })
      .prefault({}),
    scoring: z
      .object({
        positive: positiveWeightsSchema.prefault({}),
        penalties: penaltyWeightsSchema.prefault({}),
        minimumEligibleScore: z.number().min(0).max(100).default(35),
      })
      .prefault({}),
    suppressionWindowsDays: z
      .object({
        recommended: z.number().int().positive().default(21),
        approved: z.number().int().positive().default(45),
        rejected: z.number().int().positive().default(14),
        published: z.number().int().positive().default(90),
      })
      .prefault({}),
    stopWords: z.array(z.string().min(1)).default([]),
    nonSemanticPrefixes: z
      .array(z.string().min(1))
      .default(["breaking", "update", "official"]),
    publisherSuffixes: z.array(z.string().min(1)).default([]),
    rumorPatterns: z.array(z.string().min(1)).default([]),
    eventKeywords: z.array(z.string().min(1)).default([]),
    eventGroups: z.record(z.string(), z.array(z.string().min(1))).default({}),
    meaningfulUpdateTerms: z.array(z.string().min(1)).default([]),
    entityRules: z.array(entityRuleSchema).default([]),
    relevanceWeights: z.record(z.string(), z.number().positive()).default({}),
    publisherGroups: z.record(z.string(), z.string().min(1)).default({}),
  })
  .superRefine((config, context) => {
    const total = Object.values(config.scoring.positive).reduce(
      (sum, value) => sum + value,
      0,
    );
    if (Math.abs(total - 100) > 0.001) {
      context.addIssue({
        code: "custom",
        path: ["scoring", "positive"],
        message: `Positive scoring weights must total 100; received ${total}`,
      });
    }
    if (config.output.aiPacketSize > config.output.maxRankedCandidates) {
      context.addIssue({
        code: "custom",
        path: ["output", "aiPacketSize"],
        message: "AI packet size cannot exceed maximum ranked candidates",
      });
    }
  });

export type RankingConfig = z.infer<typeof rankingConfigSchema>;
export type EntityRule = z.infer<typeof entityRuleSchema>;

export function parseRankingConfig(text: string): RankingConfig {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new Error(
      `Ranking configuration is not valid YAML: ${message(error)}`,
      { cause: error },
    );
  }
  const result = rankingConfigSchema.safeParse(document);
  if (!result.success) {
    throw new Error(
      `Invalid ranking configuration: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

export async function loadRankingConfig(path: string): Promise<RankingConfig> {
  return parseRankingConfig(await readFile(path, "utf8"));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
