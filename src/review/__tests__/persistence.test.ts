import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalApprovalRecordSchema } from "../models";
import {
  FileFinalApprovalRepository,
  FileReviewTaskRepository,
} from "../storage";

const record = finalApprovalRecordSchema.parse({
  id: "finalapproval_aaaaaaaaaaaaaaaaaaaaaaaa",
  shortId: "aaaaaaaaaaaa",
  topicId: "topic_fixture",
  draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
  draftVersion: 1,
  reviewId: "review_aaaaaaaaaaaaaaaaaaaaaaaa",
  reviewVersion: 1,
  telegramChatId: "100",
  telegramUserId: "200",
  status: "approved",
  action: "approve_publish",
  approvalNotes: [],
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  telegramUpdateId: 1,
  version: 1,
});

describe("review persistence", () => {
  it("writes private task files with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "m6-task-"));
    const path = await new FileReviewTaskRepository(root).write("topic", 1, {
      "review-input.json": "{}\n",
    });
    expect((await stat(join(path, "review-input.json"))).mode & 0o777).toBe(
      0o600,
    );
  });
  it("does not overwrite an immutable approval version", async () => {
    const root = await mkdtemp(join(tmpdir(), "m6-approval-"));
    const repository = new FileFinalApprovalRepository(root);
    await repository.save(record);
    await expect(
      repository.save({ ...record, status: "rejected" }),
    ).rejects.toThrow(/already exists/);
    expect((await repository.get("topic_fixture"))?.status).toBe("approved");
  });
  it("fails closed on corrupt approval state", async () => {
    const root = await mkdtemp(join(tmpdir(), "m6-corrupt-"));
    const repository = new FileFinalApprovalRepository(root);
    await repository.save(record);
    const path = join(root, "approvals", "topic_fixture", "v1.json");
    await writeFile(path, "{bad", "utf8");
    await expect(repository.get("topic_fixture")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{bad");
  });
});
