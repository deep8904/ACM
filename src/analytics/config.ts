import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { analyticsProviderSchema, performancePeriodSchema } from "./models";

export const analyticsConfigSchema = z
  .object({
    enabledProviders: z.array(analyticsProviderSchema).min(1),
    reportingTimezone: z.literal("America/Phoenix"),
    comparisonPeriods: z
      .array(
        z.enum([
          "previous_period",
          "previous_10_publications",
          "same_type",
          "same_category",
        ]),
      )
      .min(1),
    metricWindows: z.array(performancePeriodSchema).min(1),
    minimumSampleSize: z.number().int().min(2).max(100),
    qualityThresholds: z
      .object({
        high: z.number().min(0).max(1),
        moderate: z.number().min(0).max(1),
        low: z.number().min(0).max(1),
      })
      .strict(),
    baselineMethod: z.literal("median"),
    insightDifferenceThreshold: z.number().min(0).max(10),
    reportCadence: z
      .object({
        weeklyDay: z.number().int().min(0).max(6),
        monthlyDay: z.number().int().min(1).max(28),
      })
      .strict(),
    socialPlatformMappings: z.record(
      z.string(),
      z.enum(["linkedin", "x", "instagram", "medium"]),
    ),
    retention: z
      .object({
        importMetadataDays: z.number().int().positive(),
        syncErrorDays: z.number().int().positive(),
      })
      .strict(),
    importLimits: z
      .object({
        maximumBytes: z.number().int().min(1024).max(50_000_000),
        maximumRows: z.number().int().min(1).max(100_000),
      })
      .strict(),
    telegramSummaryCharacters: z.number().int().min(200).max(3500),
    dashboardEnabled: z.literal(false),
    assistedAnalysisPacketBytes: z.number().int().min(1000).max(1_000_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (!(
      value.qualityThresholds.high > value.qualityThresholds.moderate &&
      value.qualityThresholds.moderate > value.qualityThresholds.low
    ))
      context.addIssue({
        code: "custom",
        message: "Data-quality thresholds must descend high > moderate > low",
      });
  });
export type AnalyticsConfig = z.infer<typeof analyticsConfigSchema>;
export async function loadAnalyticsConfig(path: string) {
  return analyticsConfigSchema.parse(parse(await readFile(path, "utf8")));
}
