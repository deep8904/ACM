import { describe, expect, it } from "vitest";

import type { RecordedTelegramCall } from "./recording-adapter";
import { conversationStateSchema } from "./models";
import {
  callbackUpdate,
  createTelegramTestHarness,
  messageUpdate,
} from "./testing";

describe("topic approval commands", () => {
  it("implements every Milestone 3 command without starting later stages", async () => {
    const h = await createTelegramTestHarness();
    await h.service.processUpdate(messageUpdate(1, "/start"));
    await h.service.processUpdate(messageUpdate(2, "/help"));
    await h.service.processUpdate(messageUpdate(3, "/topics"));
    const initial = await h.repository.listQueue();
    expect(initial).toHaveLength(3);
    await h.service.processUpdate(messageUpdate(4, "/queue"));
    await h.service.processUpdate(
      messageUpdate(5, `/status ${initial[0]?.shortId}`),
    );
    await h.service.processUpdate(messageUpdate(6, "/approve 1"));
    await h.service.processUpdate(messageUpdate(7, "/reject 1"));
    await h.service.processUpdate(messageUpdate(8, "/replace"));
    await h.service.processUpdate(
      messageUpdate(9, "/add New Apple developer framework"),
    );
    await h.service.processUpdate(
      messageUpdate(
        10,
        "/link https://example.com/article?utm_source=test&id=4",
      ),
    );
    const approved = (await h.repository.listQueue()).find(
      ({ approvalStatus }) => approvalStatus === "approved",
    );
    expect(approved).toBeDefined();
    await h.service.processUpdate(
      messageUpdate(11, `/cancel ${approved?.shortId}`),
    );
    await h.service.processUpdate(messageUpdate(12, "/queue all"));

    const queue = await h.repository.listQueue();
    expect(queue.some(({ origin }) => origin === "manual_topic")).toBe(true);
    expect(queue.some(({ origin }) => origin === "manual_url")).toBe(true);
    expect(
      queue.some(({ approvalStatus }) => approvalStatus === "rejected"),
    ).toBe(true);
    expect(
      queue.some(({ approvalStatus }) => approvalStatus === "cancelled"),
    ).toBe(true);
    expect((await h.repository.listApprovedEvents())[0]).toMatchObject({
      status: "cancelled",
      consumed: false,
    });
    const output = JSON.stringify(h.adapter.calls);
    expect(output).not.toMatch(/research packet|article draft|publish now/i);
  });
});

describe("topic callbacks", () => {
  it("supports sources, angle, note, approve, reject, stale, tampered, and duplicate callbacks", async () => {
    const h = await createTelegramTestHarness();
    await h.service.processUpdate(messageUpdate(20, "/topics"));
    const cards = recommendationCards(h.adapter.calls);
    const firstButtons = cards[0]!.buttons.flat();
    const secondButtons = cards[1]!.buttons.flat();
    await h.service.processUpdate(
      callbackUpdate(21, "sources_one", button(firstButtons, "Sources")),
    );
    await h.service.processUpdate(
      callbackUpdate(22, "angle_one", button(firstButtons, "Change angle")),
    );
    await h.service.processUpdate(
      messageUpdate(23, "A sharper developer workflow angle"),
    );
    const refreshed = latestUpdatedCard(h.adapter.calls);
    await h.service.processUpdate(
      callbackUpdate(
        24,
        "note_one",
        button(refreshed.buttons.flat(), "Add note"),
      ),
    );
    await h.service.processUpdate(
      messageUpdate(25, "Emphasize practical limitations"),
    );
    const newest = latestUpdatedCard(h.adapter.calls);
    const approveData = button(newest.buttons.flat(), "Approve");
    await h.service.processUpdate(
      callbackUpdate(26, "approve_one", approveData),
    );
    await h.service.processUpdate(callbackUpdate(27, "stale_one", approveData));
    await h.service.processUpdate(
      callbackUpdate(28, "reject_two", button(secondButtons, "Skip"), 1001),
    );
    await h.service.processUpdate(
      messageUpdate(29, "Too similar to recent coverage"),
    );
    await h.service.processUpdate(
      callbackUpdate(30, "tampered", "t:a:aaaaaaaaaaaa:1:tamperedxx"),
    );
    const duplicate = callbackUpdate(
      31,
      "duplicate_callback",
      button(cards[2]!.buttons.flat(), "Sources"),
      1002,
    );
    expect((await h.service.processUpdate(duplicate)).status).toBe("processed");
    expect((await h.service.processUpdate(duplicate)).status).toBe("duplicate");

    const queue = await h.repository.listQueue();
    const firstTopic = queue.find(
      ({ topicId }) => topicId === cards[0]?.topicId,
    );
    expect(firstTopic).toMatchObject({
      approvalStatus: "approved",
      requestedAngle: "A sharper developer workflow angle",
      editorialNotes: ["Emphasize practical limitations"],
    });
    expect(
      queue.find(({ topicId }) => topicId === cards[1]?.topicId)
        ?.approvalStatus,
    ).toBe("rejected");
  });

  it("rejects an expired topic without creating approval state", async () => {
    const h = await createTelegramTestHarness();
    await h.service.processUpdate(messageUpdate(35, "/topics"));
    const cards = recommendationCards(h.adapter.calls);
    const item = (await h.repository.listQueue()).find(
      ({ topicId }) => topicId === cards[0]?.topicId,
    );
    expect(item).toBeDefined();
    await h.repository.saveQueueItem(
      { ...item!, expiresAt: "2026-08-06T19:00:00.000Z" },
      item!.version,
    );
    await h.service.processUpdate(
      callbackUpdate(
        36,
        "expired_topic",
        button(cards[0]!.buttons.flat(), "Approve"),
      ),
    );
    expect(await h.repository.getByTopicId(item!.topicId)).toBeUndefined();
    expect(
      (await h.repository.getQueueItem(item!.topicId))?.approvalStatus,
    ).toBe("pending");
  });
});

describe("conversation state", () => {
  it("supports follow-ups, expiry, cancellation, and unexpected text", async () => {
    const h = await createTelegramTestHarness();
    await h.service.processUpdate(messageUpdate(40, "/add"));
    expect(
      (await h.repository.getConversation("246810", "135790"))?.state,
    ).toBe("awaiting_custom_topic");
    await h.service.processUpdate(
      messageUpdate(41, "A custom rendering topic"),
    );
    expect(
      await h.repository.getConversation("246810", "135790"),
    ).toBeUndefined();
    await h.service.processUpdate(messageUpdate(42, "/link"));
    await h.service.processUpdate(messageUpdate(43, "/cancel"));
    expect(
      await h.repository.getConversation("246810", "135790"),
    ).toBeUndefined();
    await h.service.processUpdate(messageUpdate(44, "unexpected private text"));
    expect(lastStatus(h.adapter.calls)).toMatch(/No input is expected/);

    await h.repository.saveConversation(
      conversationStateSchema.parse({
        id: "conversation_aaaaaaaaaaaaaaaaaaaaaaaa",
        chatId: "246810",
        userId: "135790",
        state: "awaiting_url",
        createdAt: "2026-08-06T18:00:00.000Z",
        expiresAt: "2026-08-06T19:00:00.000Z",
        version: 1,
      }),
    );
    await h.service.processUpdate(
      messageUpdate(45, "https://example.com/expired"),
    );
    expect(lastStatus(h.adapter.calls)).toMatch(/expired/);
  });
});

function recommendationCards(calls: readonly RecordedTelegramCall[]) {
  const call = calls.find(
    (
      value,
    ): value is Extract<
      RecordedTelegramCall,
      { method: "sendTopicRecommendations" }
    > => value.method === "sendTopicRecommendations",
  );
  if (!call) throw new Error("Missing recommendation call");
  return call.cards;
}

function latestUpdatedCard(calls: readonly RecordedTelegramCall[]) {
  const call = [...calls]
    .reverse()
    .find(
      (
        value,
      ): value is Extract<
        RecordedTelegramCall,
        { method: "updateTopicMessage" }
      > => value.method === "updateTopicMessage",
    );
  if (!call) throw new Error("Missing updated card");
  return call.card;
}

function button(
  buttons: readonly { text: string; callbackData: string }[],
  text: string,
): string {
  const value = buttons.find((item) => item.text === text)?.callbackData;
  if (!value) throw new Error(`Missing ${text} button`);
  return value;
}

function lastStatus(calls: readonly RecordedTelegramCall[]): string {
  const call = [...calls]
    .reverse()
    .find(
      (
        value,
      ): value is Extract<
        RecordedTelegramCall,
        { method: "sendStatusMessage" }
      > => value.method === "sendStatusMessage",
    );
  return call?.text ?? "";
}
