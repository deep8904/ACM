import { z } from "zod";

import { deduplicateItems } from "./deduplicate";
import type { WorkflowArtifactRepository } from "../database/artifacts";
import type { SourceConfigFile } from "./config/source-config";
import type {
  AdapterContext,
  FetchImplementation,
  TrendSourceAdapter,
} from "./adapters/types";
import {
  log as defaultLog,
  type LogContext,
  type LogLevel,
} from "../lib/logger";
import {
  sourceItemSchema,
  type SourceItem,
  type SourceType,
} from "./models/source-item";
import {
  discoveryReportSchema,
  type DiscoveryArtifacts,
  type DiscoveryReport,
  type SourceRunReport,
} from "./persistence";

export interface DiscoveryOptions {
  runId: string;
  config: SourceConfigFile;
  adapters: readonly TrendSourceAdapter[];
  fetch: FetchImplementation;
  lookbackHours?: number;
  windowStart?: string;
  windowEnd?: string;
  maxItems?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: (level: LogLevel, message: string, context: LogContext) => void;
  artifactRepository: WorkflowArtifactRepository;
}

export interface DiscoveryRunResult extends DiscoveryArtifacts {
  outputDirectory: string;
}

export async function runDiscovery(
  options: DiscoveryOptions,
): Promise<DiscoveryRunResult> {
  const existing = await readRepositoryArtifacts(
    options.artifactRepository,
    options.runId,
  );
  if (existing) {
    (options.logger ?? defaultLog)("info", "Discovery run reused", {
      runId: options.runId,
      stage: "DISCOVERING",
    });
    return {
      ...existing,
      outputDirectory: options.artifactRepository.location(
        options.runId,
        "discovery",
      ),
    };
  }

  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const logger = options.logger ?? defaultLog;
  const startedAt = now().toISOString();
  const lookbackSince =
    options.windowStart ??
    (options.lookbackHours
      ? new Date(
          new Date(startedAt).getTime() - options.lookbackHours * 3_600_000,
        ).toISOString()
      : undefined);
  const adapterIndex = indexAdapters(options.adapters);
  const rawItems: SourceItem[] = [];
  const sourceReports: SourceRunReport[] = [];

  logger("info", "Discovery run started", {
    runId: options.runId,
    stage: "DISCOVERING",
  });

  for (const source of options.config.sources) {
    if (!source.enabled) continue;
    const sourceStartedAt = monotonicNow();
    const adapter = adapterIndex.get(source.type);
    if (!adapter) {
      sourceReports.push({
        sourceId: source.id,
        status: "failed",
        itemCount: 0,
        durationMs: elapsed(monotonicNow(), sourceStartedAt),
        warnings: [],
        error: `No adapter registered for ${source.type}`,
      });
      continue;
    }

    const context: AdapterContext = {
      runId: options.runId,
      retrievedAt: startedAt,
      lookbackSince,
      windowUntil: options.windowEnd,
      maxItems: options.maxItems,
      fetch: options.fetch,
      sleep: options.sleep,
    };

    try {
      const result = await adapter.fetchItems(source, context);
      rawItems.push(...result.items);
      const durationMs = elapsed(monotonicNow(), sourceStartedAt);
      sourceReports.push({
        sourceId: source.id,
        status: "success",
        itemCount: result.items.length,
        durationMs,
        warnings: result.warnings,
      });
      logger("info", "Discovery source completed", {
        runId: options.runId,
        stage: "DISCOVERING",
        provider: source.id,
        durationMs,
      });
    } catch (error) {
      const durationMs = elapsed(monotonicNow(), sourceStartedAt);
      const message = errorMessage(error);
      sourceReports.push({
        sourceId: source.id,
        status: "failed",
        itemCount: 0,
        durationMs,
        warnings: [],
        error: message,
      });
      logger("error", "Discovery source failed", {
        runId: options.runId,
        stage: "DISCOVERING",
        provider: source.id,
        durationMs,
      });
    }
  }

  const deduplicated = deduplicateItems(rawItems);
  const report: DiscoveryReport = {
    runId: options.runId,
    stage: "DISCOVERING",
    startedAt,
    completedAt: now().toISOString(),
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    sourceReports,
    deduplication: deduplicated.report,
  };
  const artifacts = { rawItems, normalizedItems: deduplicated.items, report };
  await writeRepositoryArtifacts(options.artifactRepository, artifacts);
  const outputDirectory = options.artifactRepository.location(
    options.runId,
    "discovery",
  );

  logger("info", "Discovery run completed", {
    runId: options.runId,
    stage: "DISCOVERING",
  });

  return { ...artifacts, outputDirectory };
}

async function readRepositoryArtifacts(
  repository: WorkflowArtifactRepository,
  runId: string,
): Promise<DiscoveryArtifacts | undefined> {
  const [raw, normalized, report] = await Promise.all([
    repository.get(runId, "discovery", "raw-items.json"),
    repository.get(runId, "discovery", "normalized-items.json"),
    repository.get(runId, "discovery", "discovery-report.json"),
  ]);
  if (!raw && !normalized && !report) return undefined;
  if (!raw || !normalized || !report) {
    throw new Error(`Incomplete durable discovery artifacts for ${runId}`);
  }
  return {
    rawItems: z.array(sourceItemSchema).parse(raw.content),
    normalizedItems: z.array(sourceItemSchema).parse(normalized.content),
    report: discoveryReportSchema.parse(report.content) as DiscoveryReport,
  };
}

async function writeRepositoryArtifacts(
  repository: WorkflowArtifactRepository,
  artifacts: DiscoveryArtifacts,
): Promise<void> {
  const runId = artifacts.report.runId;
  await Promise.all([
    repository.save({
      runId,
      stage: "discovery",
      name: "raw-items.json",
      mediaType: "application/json",
      content: z.array(sourceItemSchema).parse(artifacts.rawItems),
    }),
    repository.save({
      runId,
      stage: "discovery",
      name: "normalized-items.json",
      mediaType: "application/json",
      content: z.array(sourceItemSchema).parse(artifacts.normalizedItems),
    }),
    repository.save({
      runId,
      stage: "discovery",
      name: "discovery-report.json",
      mediaType: "application/json",
      content: discoveryReportSchema.parse(artifacts.report),
    }),
  ]);
}

function indexAdapters(
  adapters: readonly TrendSourceAdapter[],
): Map<SourceType, TrendSourceAdapter> {
  const index = new Map<SourceType, TrendSourceAdapter>();
  for (const adapter of adapters) {
    for (const type of adapter.supportedTypes) {
      if (index.has(type))
        throw new Error(`Multiple adapters registered for ${type}`);
      index.set(type, adapter);
    }
  }
  return index;
}

function elapsed(end: number, start: number): number {
  return Math.max(0, Math.round(end - start));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
