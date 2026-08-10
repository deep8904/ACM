import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { loadRankingConfig } from "./config";
import { FileHistoryRepository } from "./history";
import { PostgresHistoryRepository } from "./postgres-history";
import { runRankingPipeline } from "./service";
import { createRepositoryComposition } from "../storage/composition";
import { sourceItemSchema } from "../discovery/models/source-item";

const modes = ["cluster", "rank", "editorial-packet", "pipeline"] as const;
type Mode = (typeof modes)[number];

export async function main(arguments_: readonly string[]): Promise<void> {
  if (arguments_.includes("--help")) {
    printHelp();
    return;
  }
  const mode = arguments_[0] as Mode | undefined;
  if (!mode || !modes.includes(mode))
    throw new Error(`Unknown ranking command: ${mode ?? "missing"}`);
  const options = parseArguments(arguments_.slice(1));
  const repositories = createRepositoryComposition({
    ...process.env,
    RUN_OUTPUT_DIRECTORY: options.outputRoot,
  });
  try {
    await repositories.verify();
    if (options.inputPath) {
      const items = z
        .array(sourceItemSchema)
        .parse(JSON.parse(await readFile(options.inputPath, "utf8")));
      await repositories.artifacts.save({
        runId: options.runId,
        stage: "discovery",
        name: "normalized-items.json",
        mediaType: "application/json",
        content: items,
      });
    }
    const history = repositories.sql
      ? new PostgresHistoryRepository(repositories.sql)
      : new FileHistoryRepository(options.historyPath);
    const result = await runRankingPipeline({
      runId: options.runId,
      config: await loadRankingConfig(options.configPath),
      history,
      artifactRepository: repositories.artifacts,
      now: options.now ? () => new Date(options.now as string) : undefined,
    });
    console.log(
      JSON.stringify({
        mode,
        runId: options.runId,
        clusters: result.clusters.length,
        candidates: result.candidates.length,
        ranked: result.ranked.length,
        suppressed: result.suppressed.length,
        aiPacketItems: result.aiPacket.length,
        outputDirectory: result.outputDirectory,
      }),
    );
  } finally {
    await repositories.close();
  }
}

interface CliOptions {
  runId: string;
  outputRoot: string;
  configPath: string;
  historyPath: string;
  now?: string;
  inputPath?: string;
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${name ?? "end"}`);
    }
    values.set(name, value);
  }
  const runId = values.get("--run-id");
  if (!runId) throw new Error("--run-id is required");
  const now = values.get("--now");
  if (now && Number.isNaN(Date.parse(now)))
    throw new Error("--now must be an ISO timestamp");
  return {
    runId,
    outputRoot: resolve(values.get("--output") ?? "data/runs"),
    configPath: resolve(
      values.get("--config") ?? "automation/config/ranking.example.yaml",
    ),
    historyPath: resolve(values.get("--history") ?? "data/history/topics.json"),
    inputPath: values.get("--input")
      ? resolve(values.get("--input") as string)
      : undefined,
    now,
  };
}

function printHelp(): void {
  console.log(
    "Usage: <cluster|rank|editorial-packet|pipeline> --run-id <id> [--input normalized-items.json] [--config path] [--history path] [--output path] [--now ISO]",
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
