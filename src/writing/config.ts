import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { articleTypeSchema } from "./models";

const range = z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .strict()
  .refine((x) => x.max >= x.min, "max must be at least min");
export const writingConfigSchema = z
  .object({
    mode: z
      .enum(["deterministic_preparation", "manual_claude_code"])
      .default("manual_claude_code"),
    slugMaxLength: z.number().int().min(30).max(120).default(80),
    maxMdxCharacters: z.number().int().min(10_000).max(200_000).default(60_000),
    maximumTags: z.number().int().min(1).max(12).default(8),
    readingWordsPerMinute: z.number().int().min(100).max(400).default(220),
    breakingNewsMaxAgeHours: z.number().int().min(1).max(168).default(72),
    unsupportedClaimLimit: z.number().int().min(0).max(10).default(0),
    maximumTaskExcerptCharacters: z
      .number()
      .int()
      .min(0)
      .max(3000)
      .default(1200),
    wordRanges: z.record(articleTypeSchema, range),
    forbiddenPhrases: z.array(z.string()).default([]),
    aiCliches: z.array(z.string()).default([]),
    allowedCategories: z.array(z.string()).min(1),
  })
  .strict();
export type WritingConfig = z.infer<typeof writingConfigSchema>;
export async function loadWritingConfig(path: string) {
  return writingConfigSchema.parse(parse(await readFile(path, "utf8")));
}
