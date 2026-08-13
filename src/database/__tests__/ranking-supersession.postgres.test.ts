import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect } from "vitest";

import {
  PostgresWorkflowArtifactRepository,
  type WorkflowArtifactRepository,
} from "../artifacts";
import type { DatabaseClient } from "../client";
import { loadRankingConfig } from "../../ranking/config";
import { FileHistoryRepository } from "../../ranking/history";
import { runRankingPipeline } from "../../ranking/service";
import { reconcileAutomationQueue } from "../../orchestration/reconcile";
import { PostgresAutomationJobRepository } from "../../orchestration/repository";
import { requireTelegramRuntimeConfig } from "../../telegram/config";
import { PostgresTopicCatalog } from "../../telegram/postgres-catalog";
import { PostgresTopicApprovalRepository } from "../../telegram/postgres-repository";
import { RecordingTelegramAdapter } from "../../telegram/recording-adapter";
import { TopicApprovalService } from "../../telegram/service";
import {
  closeDatabaseClient,
  postgresTest,
  suffix,
  testClient,
} from "./helpers";

let sql: DatabaseClient | undefined;
afterAll(async () => {
  if (sql) await closeDatabaseClient(sql);
});

describe("actionable ranking-set supersession", () => {
  postgresTest(
    "keeps real manual candidates across empty runs and reconciliation, then supersedes atomically and idempotently",
    async () => {
      sql = await testClient();
      const artifacts = new PostgresWorkflowArtifactRepository(sql);
      const token = suffix().replaceAll(/[^a-zA-Z0-9]/g, "");
      const manualRun = `run_${token}_manual_test`;
      const emptyRun = `run_${token}_empty`;
      const scheduledRun = `run_${token}_scheduled`;
      await seedRankedRun(artifacts, manualRun, "2026-08-13T16:47:00.000Z");
      await seedEmptyRun(artifacts, emptyRun, "2026-08-13T16:48:00.000Z");
      await seedRankedRun(artifacts, scheduledRun, "2026-08-14T16:00:00.000Z");

      const repository = new PostgresTopicApprovalRepository(sql);
      const catalog = new PostgresTopicCatalog(sql);
      const adapter = new RecordingTelegramAdapter();
      const config = requireTelegramRuntimeConfig(
        {
          NODE_ENV: "test",
          TELEGRAM_ALLOWED_CHAT_IDS: "246810",
          TELEGRAM_ALLOWED_USER_IDS: "135790",
          TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret-32-characters",
          TELEGRAM_CALLBACK_SECRET: "fixture-callback-secret-32-characters",
          TELEGRAM_RECOMMENDATION_BATCH_SIZE: "3",
        },
        "replay",
      );
      const service = new TopicApprovalService({
        adapter,
        repository,
        catalog,
        config,
        now: () => new Date("2026-08-13T17:00:00.000Z"),
        logger: () => undefined,
      });
      const cursorBefore = await scheduleCursor(sql);

      await service.showTopics("246810", manualRun, true, "manual_test");
      expect(await catalog.latestRunId()).toBe(manualRun);
      expect(
        (await repository.listQueue()).filter(
          (item) =>
            item.runId === manualRun && item.approvalStatus === "pending",
        ),
      ).toHaveLength(3);

      await service.showTopics("246810", emptyRun, true, "other");
      expect(await catalog.latestRunId()).toBe(manualRun);
      await service.showTopics("246810");
      expect(
        adapter.calls
          .filter((call) => call.method === "sendTopicRecommendations")
          .at(-1),
      ).toMatchObject({ cards: expect.arrayContaining([expect.any(Object)]) });

      await reconcileAutomationQueue(
        sql,
        new PostgresAutomationJobRepository(sql),
        new Date("2026-08-13T17:15:00.000Z"),
      );
      expect(await catalog.latestRunId()).toBe(manualRun);

      await service.showTopics("246810", scheduledRun, true, "scheduled");
      expect(await catalog.latestRunId()).toBe(scheduledRun);
      const afterReplacement = await repository.listQueue();
      expect(
        afterReplacement.filter((item) => item.runId === scheduledRun),
      ).toHaveLength(3);
      expect(
        afterReplacement
          .filter(
            (item) => item.origin === "ranked" && item.runId !== scheduledRun,
          )
          .every((item) => item.approvalStatus === "superseded"),
      ).toBe(true);

      const versions = afterReplacement
        .filter((item) => item.runId === manualRun)
        .map((item) => item.version);
      await service.showTopics("246810", scheduledRun, true, "scheduled");
      expect(
        (await repository.listQueue())
          .filter((item) => item.runId === manualRun)
          .map((item) => item.version),
      ).toEqual(versions);
      expect(await scheduleCursor(sql)).toEqual(cursorBefore);
    },
  );
});

async function seedRankedRun(
  artifacts: WorkflowArtifactRepository,
  runId: string,
  now: string,
) {
  await artifacts.save({
    runId,
    stage: "discovery",
    name: "normalized-items.json",
    mediaType: "application/json",
    content: JSON.parse(
      await readFile(
        resolve("data/samples/ranking-normalized-items.json"),
        "utf8",
      ),
    ) as unknown,
  });
  await runRankingPipeline({
    runId,
    artifactRepository: artifacts,
    config: await loadRankingConfig(
      resolve("automation/config/ranking.example.yaml"),
    ),
    history: new FileHistoryRepository(
      resolve("data/samples/ranking-history.json"),
    ),
    now: () => new Date(now),
    logger: () => undefined,
  });
}

async function seedEmptyRun(
  artifacts: WorkflowArtifactRepository,
  runId: string,
  createdAt: string,
) {
  for (const [stage, name, content] of [
    ["discovery", "normalized-items.json", []],
    ["ranking", "ranked-topics.json", []],
    ["ranking", "story-clusters.json", []],
    ["ranking", "ranking-report.json", { createdAt }],
  ] as const)
    await artifacts.save({
      runId,
      stage,
      name,
      mediaType: "application/json",
      content,
    });
}

async function scheduleCursor(client: DatabaseClient) {
  return client`
    select last_window_start,last_window_end,last_run_id
    from content_machine.discovery_schedule_state where id='primary'
  `;
}
