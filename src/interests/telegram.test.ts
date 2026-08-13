import { describe, expect, it, vi } from "vitest";

import type { TelegramActor } from "../telegram/authorization";
import type { TelegramUpdate } from "../telegram/models";
import { RecordingTelegramAdapter } from "../telegram/recording-adapter";
import type { EditorialInterest } from "./models";
import { EditorialInterestTelegramController } from "./telegram";

const actor: TelegramActor = { chatId: "42", userId: "7", chatType: "private" };
const interest: EditorialInterest = {
  id: "interest_aaaaaaaaaaaaaaaaaaaaaaaa",
  shortId: "aaaaaaaaaaaa",
  name: "Display technology",
  keywords: ["monitor", "oled"],
  status: "enabled",
  isDefault: false,
  version: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("editorial interest Telegram controls", () => {
  it("lists interests and applies a signed button change with version checking", async () => {
    const adapter = new RecordingTelegramAdapter();
    const repository = {
      list: vi.fn().mockResolvedValue([interest]),
      add: vi.fn(),
      setStatus: vi.fn().mockResolvedValue({ ...interest, status: "disabled" }),
    };
    const controller = new EditorialInterestTelegramController({
      repository: repository as never,
      adapter,
      callbackSecret: "test-secret-with-enough-entropy",
    });

    await controller.processCommand("/interests", "", message(1), actor);
    const card = adapter.calls.find(
      (call) => call.method === "sendFinalReviewCard",
    );
    expect(
      card && card.method === "sendFinalReviewCard" ? card.card.text : "",
    ).toContain("Display technology");
    const callbackData =
      card && card.method === "sendFinalReviewCard"
        ? card.card.buttons[0]![0]!.callbackData
        : "";
    expect(callbackData.length).toBeLessThanOrEqual(64);

    await controller.processCallback(callback(2, callbackData), actor);
    expect(repository.setStatus).toHaveBeenCalledWith(
      interest.shortId,
      "disabled",
      { chatId: "42", userId: "7", updateId: 2 },
      3,
    );
    expect(adapter.calls).toContainEqual({
      method: "answerCallback",
      callbackQueryId: "callback-2",
      text: "Interest updated",
      showAlert: false,
    });
  });

  it("adds an enabled interest from the documented command syntax", async () => {
    const adapter = new RecordingTelegramAdapter();
    const repository = {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue(interest),
      setStatus: vi.fn(),
    };
    const controller = new EditorialInterestTelegramController({
      repository: repository as never,
      adapter,
      callbackSecret: "test-secret-with-enough-entropy",
    });

    await controller.processCommand(
      "/interest_add",
      "Display technology | monitor, oled, monitor",
      message(3),
      actor,
    );
    expect(repository.add).toHaveBeenCalledWith(
      "Display technology",
      ["monitor", "oled", "monitor"],
      { chatId: "42", userId: "7", updateId: 3 },
    );
  });
});

function message(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false },
      text: "/interests",
    },
  };
}

function callback(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 7, is_bot: false },
      message: message(updateId).message,
      data,
    },
  };
}
