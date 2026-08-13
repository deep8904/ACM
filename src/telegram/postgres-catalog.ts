import { z } from "zod";

import type { DatabaseClient } from "../database/client";
import { sourceItemSchema } from "../discovery/models/source-item";
import { storyClusterSchema, topicCandidateSchema } from "../ranking/models";
import { TelegramControlError } from "./errors";
import type { RankedRun, TopicCatalog } from "./interfaces";

export class PostgresTopicCatalog implements TopicCatalog {
  constructor(private sql: DatabaseClient) {}
  async latestRunId(): Promise<string> {
    const rows = await this.sql<{ run_id: string }[]>`
      select run_id from content_machine.ranking_sets
      where status='actionable'
      limit 1
    `;
    if (!rows[0])
      throw new TelegramControlError(
        "missing_topic",
        "No ranked topic runs are available",
        404,
      );
    return rows[0].run_id;
  }
  async getRun(requestedRunId?: string): Promise<RankedRun> {
    const runId = requestedRunId ?? (await this.latestRunId());
    const rows = await this.sql<
      { name: string; payload: unknown; content_text: string | null }[]
    >`
      select name,payload,content_text from content_machine.workflow_artifacts
      where run_id=${runId} and ((stage='ranking' and name in ('ranked-topics.json','story-clusters.json')) or
        (stage='discovery' and name='normalized-items.json'))
    `;
    const values = new Map(
      rows.map((row) => [
        row.name,
        row.payload ??
          (row.content_text
            ? (JSON.parse(row.content_text) as unknown)
            : undefined),
      ]),
    );
    try {
      return {
        runId,
        candidates: z
          .array(topicCandidateSchema)
          .parse(values.get("ranked-topics.json")),
        clusters: z
          .array(storyClusterSchema)
          .parse(values.get("story-clusters.json")),
        sourceItems: z
          .array(sourceItemSchema)
          .parse(values.get("normalized-items.json") ?? []),
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
