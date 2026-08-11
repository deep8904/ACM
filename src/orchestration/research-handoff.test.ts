import { describe, expect, it, vi } from "vitest";

import { automationJobSchema } from "./models";
import {
  InvalidResearchHandoffError,
  loadResearchHandoff,
  researchAutomationInput,
} from "./research-handoff";
import { topicApprovedEventSchema } from "../telegram/models";
import type { ApprovedEventRepository } from "../research/interfaces";

const event = topicApprovedEventSchema.parse({
  id: "event_509d1ba7456cbe4e7d149952",
  runId: "manual_20260807",
  origin: "manual_url",
  status: "ready",
  topicId: "topic_manual_4c603d43de72f01e1821878c",
  version: 1,
  consumed: false,
  approvedAt: "2026-08-07T22:43:23.652Z",
  approvedBy: {
    telegramChatId: "1000478840",
    telegramUserId: "1000478840",
  },
  candidateId: "manual_4c603d43de72f01e1821878c",
  approvedAngle: "",
  sourceItemIds: [],
  editorialNotes: [],
});

function repository(): ApprovedEventRepository {
  return {
    next: vi.fn(),
    get: vi.fn(async (id) => (id === event.id ? event : undefined)),
    queue: vi.fn(),
    isCancelled: vi.fn(async () => false),
    isConsumed: vi.fn(async () => false),
    consume: vi.fn(),
  };
}

function durableJob() {
  return automationJobSchema.parse({
    id: "automationjob_062356977f80a1ee382f965d",
    idempotencyKey: researchAutomationInput(event).idempotencyKey,
    type: "research",
    status: "retryable",
    topicId: event.topicId,
    lineageKey: event.id,
    payload: { eventId: event.id },
    attempt: 2,
    maximumAttempts: 3,
    availableAt: "2026-08-11T06:40:00.000Z",
    createdAt: "2026-08-11T05:43:29.535Z",
    updatedAt: "2026-08-11T06:36:38.522Z",
    version: 4,
  });
}

describe("research automation handoff", () => {
  it("survives durable JSON serialization and restart with full lineage", async () => {
    const restarted = automationJobSchema.parse(
      JSON.parse(JSON.stringify(durableJob())),
    );
    await expect(loadResearchHandoff(restarted, repository())).resolves.toEqual(
      event,
    );
  });

  it("keeps retries idempotent for the same approved event", async () => {
    expect(researchAutomationInput(event)).toEqual(
      researchAutomationInput(event),
    );
    const events = repository();
    const restarted = durableJob();
    const [first, second] = await Promise.all([
      loadResearchHandoff(restarted, events),
      loadResearchHandoff(restarted, events),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.topicId).toBe(second.topicId);
  });

  it("blocks the exact legacy production fixture handoff", async () => {
    const malformed = automationJobSchema.parse({
      ...durableJob(),
      id: "automationjob_6d250f139e6300aae56a81e2",
      topicId: "topic_1786296814304_cfaa66d6193ac8",
      lineageKey: "event_1786296814304_cfaa66d6193ac8",
      payload: { eventId: "event_1786296814304_cfaa66d6193ac8" },
    });
    await expect(loadResearchHandoff(malformed, repository())).rejects.toThrow(
      InvalidResearchHandoffError,
    );
  });
});
