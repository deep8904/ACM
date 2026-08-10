import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { writeAtomicJson } from "../discovery/persistence";
import { FileTopicCatalog } from "./catalog";
import { requireTelegramRuntimeConfig } from "./config";
import { FileTelegramRepository } from "./file-repository";
import { telegramUpdateSchema } from "./models";
import { RecordingTelegramAdapter } from "./recording-adapter";
import { TopicApprovalService } from "./service";

export async function main(arguments_: readonly string[]): Promise<void> {
  const values = parseArguments(arguments_);
  const fixturePath = resolve(required(values, "--fixture"));
  const stateDirectory = resolve(
    values.get("--state") ?? "data/telegram-replay",
  );
  const runsDirectory = resolve(values.get("--runs") ?? "data/runs");
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  const updates = z
    .union([telegramUpdateSchema, z.array(telegramUpdateSchema)])
    .parse(raw);
  const list = Array.isArray(updates) ? updates : [updates];
  const first = list[0];
  const message = first?.message ?? first?.callback_query?.message;
  const user = first?.message?.from ?? first?.callback_query?.from;
  if (!message || !user)
    throw new Error("Replay fixture requires actor and chat data");
  const config = requireTelegramRuntimeConfig(
    {
      NODE_ENV: "test",
      TELEGRAM_ALLOWED_CHAT_IDS: String(message.chat.id),
      TELEGRAM_ALLOWED_USER_IDS: String(user.id),
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
    dnsLookup: async () => ["93.184.216.34"],
  });
  const results = [];
  for (const update of list) results.push(await service.processUpdate(update));
  const callsPath = resolve(stateDirectory, "replay-calls.json");
  await writeAtomicJson(callsPath, adapter.calls);
  console.log(
    JSON.stringify({
      fixture: fixturePath,
      updates: list.length,
      results,
      mockCalls: adapter.calls.length,
      stateDirectory,
      callsPath,
    }),
  );
}

function parseArguments(arguments_: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(`Invalid argument near ${name ?? "end"}`);
    values.set(name, value);
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
