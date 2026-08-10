import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FeedAdapter } from "./adapters/feed-adapter";
import { HackerNewsAdapter } from "./adapters/hacker-news-adapter";
import type { FetchImplementation } from "./adapters/types";
import { loadSourceConfig } from "./config/source-config";
import { runDiscovery } from "./discovery-service";
import { createFixtureFetch } from "./fixture-fetch";
import { runIdSchema } from "./persistence";
import { createRepositoryComposition } from "../storage/composition";

interface CliOptions {
  configPath: string;
  outputRoot: string;
  runId: string;
  lookbackHours?: number;
  maxItems?: number;
  fixturesPath?: string;
}

export async function main(arguments_: readonly string[]): Promise<void> {
  const options = parseArguments(arguments_);
  const repositories = createRepositoryComposition({
    ...process.env,
    RUN_OUTPUT_DIRECTORY: options.outputRoot,
  });
  try {
    await repositories.verify();
    const config = await loadSourceConfig(options.configPath);
    const fetchImplementation: FetchImplementation = options.fixturesPath
      ? createFixtureFetch(options.fixturesPath)
      : (input, init) => fetch(input, init);
    const result = await runDiscovery({
      runId: options.runId,
      config,
      adapters: [new FeedAdapter(), new HackerNewsAdapter()],
      fetch: fetchImplementation,
      lookbackHours: options.lookbackHours,
      maxItems: options.maxItems,
      artifactRepository: repositories.artifacts,
    });

    const failedSources = result.report.sourceReports.filter(
      ({ status }) => status === "failed",
    ).length;
    console.log(
      JSON.stringify({
        runId: options.runId,
        inputCount: result.report.deduplication.inputCount,
        outputCount: result.report.deduplication.outputCount,
        duplicateCount: result.report.deduplication.duplicateCount,
        failedSources,
        outputDirectory: result.outputDirectory,
      }),
    );
  } finally {
    await repositories.close();
  }
}

export function parseArguments(arguments_: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--"))
      throw new Error(`Unexpected argument: ${argument}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  const runId = values.get("--run-id") ?? generateRunId();
  runIdSchema.parse(runId);
  return {
    configPath: resolve(
      values.get("--config") ?? "automation/config/sources.example.yaml",
    ),
    outputRoot: resolve(values.get("--output") ?? "data/runs"),
    runId,
    lookbackHours: optionalPositiveNumber(
      values.get("--lookback-hours"),
      "--lookback-hours",
    ),
    maxItems: optionalPositiveInteger(values.get("--max-items"), "--max-items"),
    fixturesPath: values.get("--fixtures")
      ? resolve(values.get("--fixtures") as string)
      : undefined,
  };
}

function generateRunId(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `run_${date}_${randomUUID().slice(0, 8)}`;
}

function optionalPositiveNumber(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${name} must be positive`);
  return parsed;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  const parsed = optionalPositiveNumber(value, name);
  if (parsed !== undefined && !Number.isInteger(parsed))
    throw new Error(`${name} must be an integer`);
  return parsed;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
