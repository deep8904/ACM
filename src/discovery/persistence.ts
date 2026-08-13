import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { DeduplicationReport } from "./deduplicate";
import type { SourceItem } from "./models/source-item";

export const runIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]{4,80}$/);

export interface SourceRunReport {
  sourceId: string;
  status: "success" | "failed";
  itemCount: number;
  durationMs: number;
  warnings: { code: string; message: string; itemReference?: string }[];
  error?: string;
}

export interface DiscoveryReport {
  runId: string;
  stage: "DISCOVERING";
  startedAt: string;
  completedAt: string;
  windowStart?: string;
  windowEnd?: string;
  sourceReports: SourceRunReport[];
  deduplication: DeduplicationReport;
}

export interface DiscoveryArtifacts {
  rawItems: SourceItem[];
  normalizedItems: SourceItem[];
  report: DiscoveryReport;
}

const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
  itemReference: z.string().optional(),
});
const duplicateReasonSchema = z.enum([
  "canonical-url",
  "source-identifier",
  "content-hash",
  "normalized-title",
]);
export const discoveryReportSchema = z.object({
  runId: runIdSchema,
  stage: z.literal("DISCOVERING"),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  windowStart: z.string().datetime({ offset: true }).optional(),
  windowEnd: z.string().datetime({ offset: true }).optional(),
  sourceReports: z.array(
    z.object({
      sourceId: z.string(),
      status: z.enum(["success", "failed"]),
      itemCount: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      warnings: z.array(warningSchema),
      error: z.string().optional(),
    }),
  ),
  deduplication: z.object({
    inputCount: z.number().int().nonnegative(),
    outputCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative(),
    reasonCounts: z.record(
      duplicateReasonSchema,
      z.number().int().nonnegative(),
    ),
    duplicates: z.array(
      z.object({
        itemId: z.string(),
        duplicateOf: z.string(),
        reason: duplicateReasonSchema,
      }),
    ),
  }),
});

export async function writeAtomicJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(`Could not atomically write ${path}`, { cause: error });
  }
}
