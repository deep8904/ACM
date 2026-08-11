import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parse } from "yaml";

export const researchConfigSchema = z.object({
  mode: z.enum(["deterministic", "assisted"]).default("assisted"),
  timeoutMs: z.number().int().min(100).max(30000).default(8000),
  maxBytes: z.number().int().min(1024).max(10_000_000).default(1_500_000),
  maxRedirects: z.number().int().min(0).max(8).default(4),
  maxSources: z.number().int().min(1).max(20).default(8),
  maxPrimarySources: z.number().int().min(0).max(10).default(5),
  maxIndependentSources: z.number().int().min(0).max(10).default(5),
  maxCommunitySources: z.number().int().min(0).max(10).default(3),
  maxPerPublisherGroup: z.number().int().min(1).max(5).default(2),
  excerptChars: z.number().int().min(100).max(500).default(400),
  totalExcerptChars: z.number().int().min(500).max(5000).default(3000),
  cacheTtlHours: z.number().int().min(1).max(8760).default(24),
  robotsCacheTtlHours: z.number().int().min(1).max(720).default(24),
  maxRetrievalAttempts: z.number().int().min(1).max(4).default(3),
  retryBaseDelayMs: z.number().int().min(100).max(10_000).default(750),
  retryMaxDelayMs: z.number().int().min(100).max(30_000).default(5_000),
  retryInlineMaxDelayMs: z.number().int().min(100).max(30_000).default(5_000),
  retryAfterMaxMs: z
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(3_600_000),
  hostRetryBudget: z.number().int().min(1).max(12).default(4),
  hostRetryWindowMinutes: z.number().int().min(1).max(1_440).default(15),
  hostCooldownMinutes: z.number().int().min(1).max(1_440).default(30),
  negativeCacheTtlMinutes: z.number().int().min(1).max(1_440).default(30),
  sufficiencyThreshold: z.number().min(0).max(100).default(70),
  abandonedClaimMinutes: z.number().int().min(1).default(30),
  userAgent: z
    .string()
    .min(1)
    .default("AIContentMachine/0.4 (+local research)"),
});
export type ResearchConfig = z.infer<typeof researchConfigSchema>;
export async function loadResearchConfig(
  path: string,
): Promise<ResearchConfig> {
  return researchConfigSchema.parse(parse(await readFile(path, "utf8")));
}
