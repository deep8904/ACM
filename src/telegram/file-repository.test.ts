import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileTelegramRepository } from "./file-repository";
import { topicQueueItemSchema } from "./models";

function queueItem() {
  return topicQueueItemSchema.parse({
    id: "queue_aaaaaaaaaaaaaaaaaaaaaaaa",
    shortId: "aaaaaaaaaaaa",
    topicId: "topic_manual_aaaaaaaaaaaaaaaaaaaaaaaa",
    candidateId: "manual_aaaaaaaaaaaaaaaaaaaaaaaa",
    runId: "manual_20260806",
    candidateSnapshot: {
      kind: "manual_topic",
      candidate: {
        id: "topic_manual_aaaaaaaaaaaaaaaaaaaaaaaa",
        candidateId: "manual_aaaaaaaaaaaaaaaaaaaaaaaa",
        runId: "manual_20260806",
        title: "A manual technology topic",
        summary: "Unresearched",
        recommendedAngle: "",
        score: null,
        selectionReasons: ["manually submitted"],
        evidenceStrength: "unresearched",
        sourceItemIds: [],
        primarySourceItemIds: [],
        submittedAt: "2026-08-06T20:00:00.000Z",
        submittedByUserId: "200",
        submittedInChatId: "100",
      },
    },
    approvalStatus: "pending",
    researchReadiness: "blocked_pending_approval",
    editorialNotes: [],
    requestedAngle: "",
    origin: "manual_topic",
    triggerState: "not_triggered",
    createdAt: "2026-08-06T20:00:00.000Z",
    updatedAt: "2026-08-06T20:00:00.000Z",
    version: 1,
  });
}

describe("FileTelegramRepository", () => {
  it("uses stable private serialization and leaves no temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-repo-"));
    const repository = new FileTelegramRepository(root);
    const item = queueItem();
    await repository.saveQueueItem(item);
    const path = join(root, "queue", `${item.topicId}.json`);
    const first = await readFile(path, "utf8");
    await repository.saveQueueItem(item, 1);
    expect(await readFile(path, "utf8")).toBe(first);
    expect(await readdir(join(root, "queue"))).toEqual([
      `${item.topicId}.json`,
    ]);
  });

  it("rejects optimistic version conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-version-"));
    const repository = new FileTelegramRepository(root);
    await repository.saveQueueItem(queueItem());
    await expect(
      repository.saveQueueItem({ ...queueItem(), version: 2 }, 99),
    ).rejects.toThrow(/changed/);
  });

  it("rejects corrupt state instead of silently replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-corrupt-"));
    const repository = new FileTelegramRepository(root);
    await repository.saveQueueItem(queueItem());
    await writeFile(
      join(root, "queue", `${queueItem().topicId}.json`),
      "{bad",
      "utf8",
    );
    await expect(repository.listQueue()).rejects.toThrow(
      /valid Telegram state/,
    );
  });

  it("claims duplicate updates and callback IDs once", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-dedupe-"));
    const repository = new FileTelegramRepository(root);
    expect(
      await repository.claimUpdate(
        1,
        "callback_one",
        "2026-08-06T20:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      await repository.claimUpdate(
        1,
        "callback_one",
        "2026-08-06T20:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      await repository.claimUpdate(
        2,
        "callback_one",
        "2026-08-06T20:00:00.000Z",
      ),
    ).toBe(false);
  });
});
