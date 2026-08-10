import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sourceItemSchema } from "../discovery/models/source-item";
import { storyClusterSchema, topicCandidateSchema } from "../ranking/models";
import { TelegramControlError } from "./errors";
import type { RankedRun, TopicCatalog } from "./interfaces";

const catalogReportSchema = z.object({
  runId: z.string().min(1),
  stage: z.literal("RANKED"),
  createdAt: z.string().datetime({ offset: true }),
});

export class FileTopicCatalog implements TopicCatalog {
  constructor(private readonly root: string) {}

  async latestRunId(): Promise<string> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      throw new TelegramControlError(
        "missing_topic",
        "No ranked topic runs are available",
        404,
        { cause: error },
      );
    }
    const reports = await Promise.all(
      names.map(async (name) => {
        try {
          const report = catalogReportSchema.parse(
            await readJson(join(this.root, name, "ranking-report.json")),
          );
          return { runId: report.runId, createdAt: report.createdAt };
        } catch {
          return undefined;
        }
      }),
    );
    const latest = reports
      .filter((value): value is { runId: string; createdAt: string } =>
        Boolean(value),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.runId.localeCompare(a.runId),
      )[0];
    if (!latest)
      throw new TelegramControlError(
        "missing_topic",
        "No ranked topic runs are available",
        404,
      );
    return latest.runId;
  }

  async getRun(requestedRunId?: string): Promise<RankedRun> {
    const runId = requestedRunId ?? (await this.latestRunId());
    const directory = join(this.root, runId);
    try {
      const [candidates, clusters] = await Promise.all([
        readJson(join(directory, "ranked-topics.json")),
        readJson(join(directory, "story-clusters.json")),
      ]);
      const sourceItems = await optionalJson(
        join(directory, "normalized-items.json"),
      );
      return {
        runId,
        candidates: z.array(topicCandidateSchema).parse(candidates),
        clusters: z.array(storyClusterSchema).parse(clusters),
        sourceItems: z.array(sourceItemSchema).parse(sourceItems ?? []),
      };
    } catch (error) {
      throw new TelegramControlError(
        "missing_topic",
        `Ranked run ${runId} is unavailable or invalid`,
        404,
        { cause: error },
      );
    }
  }
}

async function readJson(path: string): Promise<unknown> {
  await stat(path);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}
