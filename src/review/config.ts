import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { reviewDecisionSchema } from "./models";

export const reviewConfigSchema = z
  .object({
    mode: z
      .enum(["deterministic", "manual_claude_code"])
      .default("manual_claude_code"),
    minimumCitationCoverage: z.number().min(0).max(100).default(85),
    maximumUnresolvedWarnings: z.number().int().min(0).max(100).default(12),
    criticalRiskBlocks: z.boolean().default(true),
    maximumQuoteWords: z.number().int().min(10).max(200).default(50),
    maximumTotalQuoteWordsPerSource: z
      .number()
      .int()
      .min(20)
      .max(1000)
      .default(120),
    maximumDuplicatePhraseSimilarity: z.number().min(0).max(1).default(0.8),
    allowedReviewDecisions: z
      .array(reviewDecisionSchema)
      .min(1)
      .default(["pass", "pass_with_warnings", "revise", "block"]),
    previewExpiryMinutes: z.number().int().min(5).max(10080).default(120),
    conversationStateExpiryMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(30),
    scheduleHorizonDays: z.number().int().min(1).max(730).default(180),
    finalApprovalCallbackExpiryMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(60),
    defaultTimezone: z.literal("America/Phoenix").default("America/Phoenix"),
    maximumTaskSourceExcerptCharacters: z
      .number()
      .int()
      .min(0)
      .max(3000)
      .default(1000),
  })
  .strict();
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
export async function loadReviewConfig(path: string) {
  return reviewConfigSchema.parse(parse(await readFile(path, "utf8")));
}
