import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FileWorkflowArtifactRepository } from "../database/artifacts";
import { loadRankingConfig } from "../ranking/config";
import { FileHistoryRepository } from "../ranking/history";
import { runRankingPipeline } from "../ranking/service";
import { FileTopicCatalog } from "./catalog";
import { requireTelegramRuntimeConfig } from "./config";
import { FileTelegramRepository } from "./file-repository";
import { RecordingTelegramAdapter } from "./recording-adapter";
import { TopicApprovalService } from "./service";

export const testNow = "2026-08-06T20:00:00.000Z";
export const testChatId = 246810;
export const testUserId = 135790;

export async function createTelegramTestHarness() {
  const root = await mkdtemp(join(tmpdir(), "ai-content-telegram-"));
  const runsDirectory = join(root, "runs");
  const stateDirectory = join(root, "telegram");
  const runId = "run_telegram_fixture";
  const artifacts = new FileWorkflowArtifactRepository(runsDirectory);
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
    now: () => new Date(testNow),
    monotonicNow: () => 100,
    logger: () => undefined,
  });
  const config = requireTelegramRuntimeConfig(
    {
      NODE_ENV: "test",
      TELEGRAM_ALLOWED_CHAT_IDS: String(testChatId),
      TELEGRAM_ALLOWED_USER_IDS: String(testUserId),
      TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret-32-characters",
      TELEGRAM_CALLBACK_SECRET: "fixture-callback-secret-32-characters",
      TELEGRAM_STATE_DIRECTORY: stateDirectory,
      TELEGRAM_RUNS_DIRECTORY: runsDirectory,
    },
    "replay",
  );
  const adapter = new RecordingTelegramAdapter();
  const repository = new FileTelegramRepository(stateDirectory);
  const service = new TopicApprovalService({
    adapter,
    repository,
    catalog: new FileTopicCatalog(runsDirectory),
    config,
    now: () => new Date(testNow),
    dnsLookup: async () => ["93.184.216.34"],
    logger: () => undefined,
  });
  return {
    root,
    runsDirectory,
    stateDirectory,
    runId,
    config,
    adapter,
    repository,
    service,
  };
}

export function messageUpdate(
  updateId: number,
  text: string,
  overrides: {
    chatId?: number;
    userId?: number;
    chatType?: "private" | "group" | "supergroup";
  } = {},
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      date: 1_785_000_000,
      chat: {
        id: overrides.chatId ?? testChatId,
        type: overrides.chatType ?? "private",
      },
      from: { id: overrides.userId ?? testUserId, is_bot: false },
      text,
    },
  } as const;
}

export function callbackUpdate(
  updateId: number,
  callbackQueryId: string,
  data: string,
  messageId = 1000,
) {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackQueryId,
      from: { id: testUserId, is_bot: false },
      message: {
        message_id: messageId,
        date: 1_785_000_000,
        chat: { id: testChatId, type: "private" },
      },
      data,
    },
  } as const;
}
