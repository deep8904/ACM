import { describe, expect, it } from "vitest";

import {
  DurableApprovedEventError,
  parseDurableApprovedEvent,
} from "./approved-event";

describe("durable approved events", () => {
  it("does not weaken the schema for the exact malformed production payload", () => {
    expect(() =>
      parseDurableApprovedEvent({
        id: "event_1786296814304_cfaa66d6193ac8",
        topicId: "topic_1786296814304_cfaa66d6193ac8",
        payload: { id: "event_1786296814304_cfaa66d6193ac8" },
      }),
    ).toThrow(DurableApprovedEventError);
  });

  it("rejects a row whose identity differs from a canonical payload", () => {
    expect(() =>
      parseDurableApprovedEvent({
        id: `event_${"a".repeat(24)}`,
        topicId: "topic_wrong",
        payload: {
          id: `event_${"a".repeat(24)}`,
          topicId: "topic_right",
          candidateId: "candidate_right",
          runId: "run_right",
          approvedAt: "2026-08-11T00:00:00.000Z",
          approvedBy: { telegramUserId: "1", telegramChatId: "1" },
          approvedAngle: "",
          editorialNotes: [],
          sourceItemIds: [],
          origin: "ranked",
          status: "ready",
          consumed: false,
          version: 1,
        },
      }),
    ).toThrow(/row identity/);
  });
});
