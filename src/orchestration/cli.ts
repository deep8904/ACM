import { pathToFileURL } from "node:url";

import { log } from "../lib/logger";
import { createRepositoryComposition } from "../storage/composition";
import { productionReadiness } from "./readiness";
import { manualDiscoveryJob, reconcileAutomationQueue } from "./reconcile";
import { PostgresAutomationJobRepository } from "./repository";
import { runAutomationWorker } from "./worker";
import { auditProductionResearch } from "./production-audit";
import { requireTelegramRuntimeConfig } from "../telegram/config";
import { TopicApprovalService } from "../telegram/service";
import { TelegramBotApiClient } from "../telegram/telegram-client";

export async function main(args: string[]) {
  const command = args[0] ?? "drain";
  if (command === "drain") {
    console.log(JSON.stringify(await runAutomationWorker(), null, 2));
    return;
  }
  if (command === "drain-selected") {
    console.log(
      JSON.stringify(
        await runAutomationWorker(
          process.env,
          selectedJobIds(
            process.env.SELECTED_JOB_IDS ?? process.env.RETRY_JOB_IDS,
            "SELECTED_JOB_IDS",
          ),
        ),
        null,
        2,
      ),
    );
    return;
  }
  const composition = createRepositoryComposition(process.env);
  try {
    await composition.verify();
    if (!composition.sql) throw new Error("PostgreSQL storage is required");
    const jobs = new PostgresAutomationJobRepository(composition.sql);
    if (command === "reconcile")
      console.log(
        JSON.stringify(
          await reconcileAutomationQueue(composition.sql, jobs),
          null,
          2,
        ),
      );
    else if (command === "manual-discovery")
      console.log(JSON.stringify(await enqueueManualDiscovery(jobs), null, 2));
    else if (command === "status")
      console.log(JSON.stringify(await jobs.list(undefined, 50), null, 2));
    else if (command === "retry")
      console.log(JSON.stringify(await jobs.retry(required(args[1])), null, 2));
    else if (command === "retry-selected") {
      const retried = [];
      for (const id of selectedRetryJobIds(process.env.RETRY_JOB_IDS))
        retried.push(await jobs.retry(id));
      console.log(JSON.stringify(retried, null, 2));
    } else if (command === "cancel")
      console.log(
        JSON.stringify(await jobs.cancel(required(args[1])), null, 2),
      );
    else if (command === "readiness")
      console.log(
        JSON.stringify(await productionReadiness(composition.sql), null, 2),
      );
    else if (command === "restore-ranking") {
      const runId = required(args[1]);
      const origin = args[2] ?? "scheduled";
      const rankingOrigin = (
        ["scheduled", "manual_test", "other"] as const
      ).find((value) => value === origin);
      if (!rankingOrigin)
        throw new Error(
          "Ranking origin must be scheduled, manual_test, or other",
        );
      const config = requireTelegramRuntimeConfig(process.env, "api");
      const service = new TopicApprovalService({
        adapter: new TelegramBotApiClient({
          botToken: config.TELEGRAM_BOT_TOKEN as string,
        }),
        repository: composition.telegram,
        catalog: composition.catalog,
        config,
      });
      for (const chatId of config.TELEGRAM_ALLOWED_CHAT_IDS)
        await service.showTopics(chatId, runId, true, rankingOrigin);
      console.log(
        JSON.stringify(
          {
            runId: await composition.catalog.latestRunId(),
            candidateCount: (
              await composition.catalog.getRun()
            ).candidates.slice(0, config.TELEGRAM_RECOMMENDATION_BATCH_SIZE)
              .length,
            notifiedChats: config.TELEGRAM_ALLOWED_CHAT_IDS.length,
          },
          null,
          2,
        ),
      );
    } else if (command === "audit") {
      const eventIds = list(process.env.AUDIT_EVENT_IDS);
      const jobIds = list(process.env.AUDIT_JOB_IDS);
      if (!eventIds.length && !jobIds.length)
        throw new Error("AUDIT_EVENT_IDS or AUDIT_JOB_IDS is required");
      console.log(
        JSON.stringify(
          await auditProductionResearch(
            composition.sql,
            composition.artifacts,
            {
              eventIds,
              jobIds,
            },
          ),
          null,
          2,
        ),
      );
    } else throw new Error(`Unknown automation command: ${command}`);
  } finally {
    await composition.close();
  }
}

async function enqueueManualDiscovery(jobs: PostgresAutomationJobRepository) {
  const input = manualDiscoveryJob({
    testId: requiredEnvironment("MANUAL_DISCOVERY_TEST_ID"),
    windowStart: requiredEnvironment("MANUAL_DISCOVERY_WINDOW_START"),
    windowEnd: requiredEnvironment("MANUAL_DISCOVERY_WINDOW_END"),
  });
  const runId = String(input.payload?.runId);
  const context = {
    runId,
    stage: "manual_discovery_enqueue",
    topicId: null,
    articleId: null,
  } as const;
  log("info", "manual_discovery_enqueue_started", context);
  try {
    const job = await jobs.enqueue(input);
    log("info", "manual_discovery_enqueue_succeeded", {
      ...context,
      result: job.id,
    });
    return job;
  } catch (error) {
    log("error", "manual_discovery_enqueue_failed", {
      ...context,
      failureSummary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function required(value: string | undefined) {
  if (!value) throw new Error("A job ID is required");
  return value;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function selectedRetryJobIds(value: string | undefined) {
  return selectedJobIds(value, "RETRY_JOB_IDS");
}

export function selectedJobIds(value: string | undefined, name: string) {
  const ids = list(value);
  if (!ids.length) throw new Error(`${name} is required`);
  if (ids.length > 10)
    throw new Error("At most 10 jobs may be selected at once");
  if (new Set(ids).size !== ids.length)
    throw new Error(`${name} must not contain duplicates`);
  for (const id of ids)
    if (!/^automationjob_[a-f0-9]{24}$/.test(id))
      throw new Error(`Invalid automation job ID: ${id}`);
  return ids;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
