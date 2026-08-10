import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ZodType } from "zod";

import { writeAtomicJson } from "../discovery/persistence";
import { TelegramControlError } from "./errors";
import type { TopicApprovalRepository } from "./interfaces";
import {
  conversationStateSchema,
  messageIndexSchema,
  processedUpdateSchema,
  topicApprovalSchema,
  topicApprovedEventSchema,
  topicQueueItemSchema,
  type ConversationState,
  type MessageIndex,
  type ProcessedUpdate,
  type TopicApproval,
  type TopicApprovedEvent,
  type TopicQueueItem,
} from "./models";

export class FileTelegramRepository implements TopicApprovalRepository {
  constructor(private readonly root: string) {}

  getById(id: string): Promise<TopicApproval | undefined> {
    return this.readOptional(
      this.path("approvals", safeName(id)),
      topicApprovalSchema,
    );
  }

  async getByTopicId(topicId: string): Promise<TopicApproval | undefined> {
    const records = await this.readAll("approvals", topicApprovalSchema);
    return records.find((record) => record.topicId === topicId);
  }

  async saveApproval(
    approval: TopicApproval,
    expectedVersion?: number,
  ): Promise<TopicApproval> {
    const validated = topicApprovalSchema.parse(approval);
    await this.assertVersion(
      this.path("approvals", safeName(validated.id)),
      topicApprovalSchema,
      expectedVersion,
    );
    await this.write(this.path("approvals", safeName(validated.id)), validated);
    return validated;
  }

  getQueueItem(topicId: string): Promise<TopicQueueItem | undefined> {
    return this.readOptional(
      this.path("queue", safeName(topicId)),
      topicQueueItemSchema,
    );
  }

  async getQueueItemByShortId(
    shortId: string,
  ): Promise<TopicQueueItem | undefined> {
    const records = await this.readAll("queue", topicQueueItemSchema);
    return records.find((record) => record.shortId === shortId);
  }

  async saveQueueItem(
    item: TopicQueueItem,
    expectedVersion?: number,
  ): Promise<TopicQueueItem> {
    const validated = topicQueueItemSchema.parse(item);
    await this.assertVersion(
      this.path("queue", safeName(validated.topicId)),
      topicQueueItemSchema,
      expectedVersion,
    );
    await this.write(
      this.path("queue", safeName(validated.topicId)),
      validated,
    );
    return validated;
  }

  async listQueue(): Promise<TopicQueueItem[]> {
    return (await this.readAll("queue", topicQueueItemSchema)).sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  getConversation(
    chatId: string,
    userId: string,
  ): Promise<ConversationState | undefined> {
    return this.readOptional(
      this.conversationPath(chatId, userId),
      conversationStateSchema,
    );
  }

  saveConversation(state: ConversationState): Promise<void> {
    return this.write(
      this.conversationPath(state.chatId, state.userId),
      conversationStateSchema.parse(state),
    );
  }

  async clearConversation(chatId: string, userId: string): Promise<void> {
    await unlink(this.conversationPath(chatId, userId)).catch(
      (error: unknown) => {
        if (!isMissing(error))
          throw this.persistenceError("Could not clear conversation", error);
      },
    );
  }

  getMessageIndex(shortId: string): Promise<MessageIndex | undefined> {
    return this.readOptional(
      this.path("message-index", safeName(shortId)),
      messageIndexSchema,
    );
  }

  saveMessageIndex(index: MessageIndex): Promise<void> {
    return this.write(
      this.path("message-index", safeName(index.shortId)),
      messageIndexSchema.parse(index),
    );
  }

  async claimUpdate(
    updateId: number,
    callbackQueryId: string | undefined,
    now: string,
  ): Promise<boolean> {
    const updatePath = this.path("processed-updates", String(updateId));
    const callbackPath = callbackQueryId
      ? this.path("processed-callbacks", safeName(callbackQueryId))
      : undefined;
    const record = processedUpdateSchema.parse({
      updateId,
      callbackQueryId,
      status: "processing",
      processedAt: now,
      commandType: "pending",
    });
    if (!(await createExclusive(updatePath, record))) return false;
    if (callbackPath && !(await createExclusive(callbackPath, record))) {
      await unlink(updatePath).catch(() => undefined);
      return false;
    }
    return true;
  }

  async completeUpdate(record: ProcessedUpdate): Promise<void> {
    const validated = processedUpdateSchema.parse({
      ...record,
      status: "completed",
    });
    await this.write(
      this.path("processed-updates", String(record.updateId)),
      validated,
    );
    if (record.callbackQueryId)
      await this.write(
        this.path("processed-callbacks", safeName(record.callbackQueryId)),
        validated,
      );
  }

  async releaseUpdate(
    updateId: number,
    callbackQueryId?: string,
  ): Promise<void> {
    await unlink(this.path("processed-updates", String(updateId))).catch(
      () => undefined,
    );
    if (callbackQueryId)
      await unlink(
        this.path("processed-callbacks", safeName(callbackQueryId)),
      ).catch(() => undefined);
  }

  async hasProcessedUpdate(updateId: number): Promise<boolean> {
    return Boolean(
      await this.readOptional(
        this.path("processed-updates", String(updateId)),
        processedUpdateSchema,
      ),
    );
  }

  async saveApprovedEvent(event: TopicApprovedEvent): Promise<boolean> {
    const validated = topicApprovedEventSchema.parse(event);
    return createExclusive(this.eventPath(validated.id), validated);
  }

  async getApprovedEventByTopicId(
    topicId: string,
  ): Promise<TopicApprovedEvent | undefined> {
    return (await this.listApprovedEvents()).find(
      (event) => event.topicId === topicId,
    );
  }

  async updateApprovedEvent(
    event: TopicApprovedEvent,
    expectedVersion: number,
  ): Promise<void> {
    const validated = topicApprovedEventSchema.parse(event);
    await this.assertVersion(
      this.eventPath(validated.id),
      topicApprovedEventSchema,
      expectedVersion,
    );
    await this.write(this.eventPath(validated.id), validated);
  }

  listApprovedEvents(): Promise<TopicApprovedEvent[]> {
    return this.readAllAt(
      join(this.root, "..", "events", "topic-approved"),
      topicApprovedEventSchema,
    );
  }

  private eventPath(id: string): string {
    return join(
      this.root,
      "..",
      "events",
      "topic-approved",
      `${safeName(id)}.json`,
    );
  }

  private conversationPath(chatId: string, userId: string): string {
    return this.path("conversations", safeName(`${chatId}_${userId}`));
  }

  private path(directory: string, id: string): string {
    return join(this.root, directory, `${id}.json`);
  }

  private async write(path: string, value: unknown): Promise<void> {
    try {
      await writeAtomicJson(path, value);
    } catch (error) {
      throw this.persistenceError(
        `Could not write Telegram state at ${path}`,
        error,
      );
    }
  }

  private async readOptional<T>(
    path: string,
    schema: ZodType<T>,
  ): Promise<T | undefined> {
    try {
      return schema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw this.persistenceError(
        `Could not read valid Telegram state at ${path}`,
        error,
      );
    }
  }

  private async readAll<T>(
    directory: string,
    schema: ZodType<T>,
  ): Promise<T[]> {
    return this.readAllAt(join(this.root, directory), schema);
  }

  private async readAllAt<T>(
    directory: string,
    schema: ZodType<T>,
  ): Promise<T[]> {
    let files: string[];
    try {
      files = (await readdir(directory))
        .filter((file) => file.endsWith(".json"))
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw this.persistenceError(
        `Could not list Telegram state at ${directory}`,
        error,
      );
    }
    return Promise.all(
      files.map(async (file) => {
        const value = await this.readOptional(join(directory, file), schema);
        if (!value)
          throw this.persistenceError(
            `Telegram state disappeared during read: ${file}`,
          );
        return value;
      }),
    );
  }

  private async assertVersion<T extends { version: number }>(
    path: string,
    schema: ZodType<T>,
    expectedVersion?: number,
  ): Promise<void> {
    if (expectedVersion === undefined) return;
    const existing = await this.readOptional(path, schema);
    if (!existing || existing.version !== expectedVersion) {
      throw new TelegramControlError(
        "queue_conflict",
        "Topic state changed; refresh the topic list",
        409,
      );
    }
  }

  private persistenceError(
    message: string,
    cause?: unknown,
  ): TelegramControlError {
    return new TelegramControlError("persistence_failure", message, 500, {
      cause,
    });
  }
}

async function createExclusive(path: string, value: unknown): Promise<boolean> {
  let handle;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    )
      return false;
    throw new TelegramControlError(
      "persistence_failure",
      `Could not claim state at ${path}`,
      500,
      { cause: error },
    );
  } finally {
    await handle?.close();
  }
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new TelegramControlError(
      "persistence_failure",
      "Unsafe state identifier",
      500,
    );
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
