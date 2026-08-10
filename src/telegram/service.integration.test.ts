import { describe, expect, it } from "vitest";

import type { RecordedTelegramCall } from "./recording-adapter";
import {
  callbackUpdate,
  createTelegramTestHarness,
  messageUpdate,
} from "./testing";

describe("offline Telegram topic approval integration", () => {
  it("approves, rejects, adds manual inputs, saves a note, lists queue, and remains idempotent", async () => {
    const h = await createTelegramTestHarness();
    await h.service.processUpdate(messageUpdate(100, "/topics"));
    const recommendation = h.adapter.calls.find(
      (
        call,
      ): call is Extract<
        RecordedTelegramCall,
        { method: "sendTopicRecommendations" }
      > => call.method === "sendTopicRecommendations",
    );
    if (!recommendation) throw new Error("Missing recommendations");
    const approve = recommendation.cards[0]?.buttons
      .flat()
      .find(({ text }) => text === "Approve")?.callbackData;
    const reject = recommendation.cards[1]?.buttons
      .flat()
      .find(({ text }) => text === "Skip")?.callbackData;
    if (!approve || !reject) throw new Error("Missing callbacks");
    const approvalUpdate = callbackUpdate(101, "integration_approve", approve);
    await h.service.processUpdate(approvalUpdate);
    await h.service.processUpdate(
      callbackUpdate(102, "integration_reject", reject, 1001),
    );
    await h.service.processUpdate(messageUpdate(103, "/cancel"));
    await h.service.processUpdate(
      messageUpdate(104, "/add Manual WebGPU tooling comparison"),
    );
    await h.service.processUpdate(
      messageUpdate(
        105,
        "/link https://example.com/review?utm_campaign=x&item=7",
      ),
    );
    await h.service.processUpdate(
      messageUpdate(
        109,
        "/link https://example.com/review?item=7&utm_source=duplicate",
      ),
    );
    const manual = (await h.repository.listQueue()).find(
      ({ origin }) => origin === "manual_topic",
    );
    if (!manual) throw new Error("Missing manual topic");
    const manualCall = [...h.adapter.calls]
      .reverse()
      .find(
        (
          call,
        ): call is Extract<
          RecordedTelegramCall,
          { method: "sendTopicRecommendations" }
        > =>
          call.method === "sendTopicRecommendations" &&
          call.cards[0]?.topicId === manual.topicId,
      );
    const note = manualCall?.cards[0]?.buttons
      .flat()
      .find(({ text }) => text === "Add note")?.callbackData;
    if (!note) throw new Error("Missing note callback");
    await h.service.processUpdate(
      callbackUpdate(106, "integration_note", note, 1005),
    );
    await h.service.processUpdate(
      messageUpdate(107, "Compare browser support and debugging tradeoffs"),
    );
    await h.service.processUpdate(messageUpdate(108, "/queue all"));

    const before = {
      events: await h.repository.listApprovedEvents(),
      queue: await h.repository.listQueue(),
      approvals: await h.repository.getByTopicId(
        (await h.repository.listQueue())[0]!.topicId,
      ),
    };
    expect((await h.service.processUpdate(approvalUpdate)).status).toBe(
      "duplicate",
    );
    const after = {
      events: await h.repository.listApprovedEvents(),
      queue: await h.repository.listQueue(),
      approvals: await h.repository.getByTopicId(
        (await h.repository.listQueue())[0]!.topicId,
      ),
    };
    expect(after).toEqual(before);
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({ consumed: false, status: "ready" });
    expect(
      after.queue.find(({ origin }) => origin === "manual_topic")
        ?.candidateSnapshot.candidate,
    ).toMatchObject({ score: null, evidenceStrength: "unresearched" });
    expect(
      after.queue.find(({ origin }) => origin === "manual_url")
        ?.candidateSnapshot.candidate,
    ).toMatchObject({
      submittedUrl: "https://example.com/review?item=7",
      score: null,
      evidenceStrength: "unresearched",
    });
    expect(
      after.queue.filter(({ origin }) => origin === "manual_url"),
    ).toHaveLength(1);
    expect(
      after.queue.find(({ origin }) => origin === "manual_topic")
        ?.editorialNotes,
    ).toEqual(["Compare browser support and debugging tradeoffs"]);
  });
});
