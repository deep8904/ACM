import { describe, expect, it, vi } from "vitest";
import { RecordingTelegramAdapter } from "../../telegram/recording-adapter";
import type { TelegramUpdate } from "../../telegram/models";
import { createFinalCallbackData } from "../callback";
import { reviewConfigSchema } from "../config";
import type { FinalApprovalService } from "../final-approval";
import { finalApprovalRecordSchema } from "../models";
import type { RevisionService } from "../revision";
import { FinalReviewTelegramController } from "../telegram";

describe("Telegram final review controller", () => {
  it("resolves server-side state and approves an exact signed callback", async () => {
    const secret = "fixture-final-callback-secret";
    const approval = finalApprovalRecordSchema.parse({
      id: "finalapproval_aaaaaaaaaaaaaaaaaaaaaaaa",
      shortId: "aaaaaaaaaaaa",
      topicId: "topic_fixture",
      draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      draftVersion: 2,
      reviewId: "review_aaaaaaaaaaaaaaaaaaaaaaaa",
      reviewVersion: 1,
      telegramChatId: "100",
      telegramUserId: "200",
      status: "pending",
      approvalNotes: [],
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
      telegramUpdateId: 40,
      version: 1,
    });
    const act = vi.fn().mockResolvedValue({ approval });
    const adapter = new RecordingTelegramAdapter();
    const controller = new FinalReviewTelegramController({
      service: { act } as unknown as FinalApprovalService,
      revision: {} as RevisionService,
      reviews: {} as never,
      drafts: {} as never,
      quality: {} as never,
      previews: {} as never,
      approvals: {
        getByShortId: async () => approval,
      } as never,
      conversations: {} as never,
      adapter,
      callbackSecret: secret,
      config: reviewConfigSchema.parse({}),
      clock: () => new Date("2026-08-06T12:10:00.000Z"),
    });
    const update = {
      update_id: 41,
      callback_query: {
        id: "final-query",
        from: { id: 200, is_bot: false },
        message: {
          message_id: 99,
          date: 1,
          chat: { id: 100, type: "private" },
          text: "Final review summary only",
        },
        data: createFinalCallbackData("p", approval.shortId, 1, secret),
      },
    } as TelegramUpdate;
    await controller.processCallback(update, {
      chatId: "100",
      userId: "200",
      chatType: "private",
    });
    expect(act).toHaveBeenCalledWith(
      "topic_fixture",
      2,
      1,
      "approve_publish",
      expect.objectContaining({
        telegramUpdateId: 41,
        callbackQueryId: "final-query",
      }),
    );
    expect(adapter.calls).toContainEqual({
      method: "answerCallback",
      callbackQueryId: "final-query",
      text: "Done",
      showAlert: false,
    });
    expect(JSON.stringify(adapter.calls)).not.toContain("article body");
  });
});
