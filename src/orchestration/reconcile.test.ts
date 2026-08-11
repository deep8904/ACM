import { describe, expect, it } from "vitest";

import type { DatabaseClient } from "../database/client";
import type { ApprovedResearchLineageRow } from "../research/approved-lineage";
import type { EnqueueAutomationJob } from "./models";
import { reconcileAutomationQueue } from "./reconcile";

const malformedEventId = "event_6296784279ae12c54771daf8";

describe("research queue reconciliation", () => {
  it("never schedules the exact malformed durable-event shape, including on repeated runs", async () => {
    const row = lineageRow({ eventPayload: { id: malformedEventId } });
    const sql = fakeDatabase([row]);
    const jobs = fakeJobs();

    const first = await reconcileAutomationQueue(sql, jobs, now);
    const second = await reconcileAutomationQueue(sql, jobs, now);

    expect(first.invalidApprovedEvents).toEqual([malformedEventId]);
    expect(second.invalidApprovedEvents).toEqual([malformedEventId]);
    expect(jobs.created()).toEqual(["discovery:2026-08-11"]);
  });

  it("creates one idempotent research job only for canonical event, queue, and approval lineage", async () => {
    const row = lineageRow();
    const sql = fakeDatabase([row]);
    const jobs = fakeJobs();

    await reconcileAutomationQueue(sql, jobs, now);
    await reconcileAutomationQueue(sql, jobs, now);

    expect(jobs.created()).toEqual(["discovery:2026-08-11", row.event_id]);
  });

  it("rejects column/payload lineage disagreement before enqueue", async () => {
    const row = lineageRow();
    row.queue_candidate_id = "manual_bbbbbbbbbbbbbbbbbbbbbbbb";
    const result = await reconcileAutomationQueue(
      fakeDatabase([row]),
      fakeJobs(),
      now,
    );

    expect(result.invalidApprovedEvents).toEqual([row.event_id]);
    expect(result.enqueued).toHaveLength(1);
  });
});

const now = new Date("2026-08-11T09:00:00.000Z");

function lineageRow(
  options: { eventPayload?: unknown } = {},
): ApprovedResearchLineageRow {
  const key = "a".repeat(24);
  const eventId = options.eventPayload ? malformedEventId : `event_${key}`;
  const topicId = `topic_manual_${key}`;
  const candidateId = `manual_${key}`;
  const runId = `manual_${key}`;
  const queueId = `queue_${key}`;
  const approvalId = `approval_${key}`;
  const createdAt = "2026-08-11T08:00:00.000Z";
  const queue = {
    id: queueId,
    shortId: key.slice(0, 12),
    topicId,
    candidateId,
    runId,
    candidateSnapshot: {
      kind: "manual_url",
      candidate: {
        id: topicId,
        candidateId,
        runId,
        title: "Official source-backed topic",
        submittedUrl: "https://example.com/official",
        summary: "",
        recommendedAngle: "Explain the update",
        score: null,
        selectionReasons: ["manually submitted"],
        evidenceStrength: "unresearched",
        sourceItemIds: [],
        primarySourceItemIds: [],
        submittedAt: createdAt,
        submittedByUserId: "1",
        submittedInChatId: "1",
      },
    },
    approvalStatus: "approved",
    researchReadiness: "ready_for_research",
    editorialNotes: [],
    requestedAngle: "Explain the update",
    origin: "manual_url",
    triggerState: "topic_approved_event_created",
    createdAt,
    updatedAt: createdAt,
    version: 2,
  };
  const approval = {
    id: approvalId,
    topicId,
    candidateId,
    runId,
    chatId: "1",
    userId: "1",
    action: "approve",
    status: "approved",
    editorialNotes: [],
    requestedAngle: "Explain the update",
    createdAt,
    updatedAt: createdAt,
    telegramUpdateId: 1,
    version: 1,
  };
  const event = {
    id: eventId,
    topicId,
    candidateId,
    runId,
    approvedAt: createdAt,
    approvedBy: { telegramUserId: "1", telegramChatId: "1" },
    approvedAngle: "Explain the update",
    editorialNotes: [],
    sourceItemIds: [],
    origin: "manual_url",
    status: "ready",
    consumed: false,
    version: 1,
  };
  return {
    event_id: eventId,
    event_topic_id: topicId,
    event_approval_id: approvalId,
    event_payload: options.eventPayload ?? event,
    queue_id: queueId,
    queue_topic_id: topicId,
    queue_candidate_id: candidateId,
    queue_run_id: runId,
    queue_approval_status: "approved",
    queue_trigger_state: "topic_approved_event_created",
    queue_payload: queue,
    approval_id: approvalId,
    approval_topic_id: topicId,
    approval_action: "approve",
    approval_status: "approved",
    approval_payload: approval,
  };
}

function fakeDatabase(rows: ApprovedResearchLineageRow[]) {
  return (async (parts: TemplateStringsArray) => {
    const query = parts.join(" ");
    return query.includes("topic_approved_events") ? rows : [];
  }) as unknown as DatabaseClient;
}

function fakeJobs() {
  const values = new Map<string, string>();
  return {
    enqueue: async (input: EnqueueAutomationJob) => {
      const id = `automationjob_${input.idempotencyKey.slice(0, 24)}`;
      values.set(input.lineageKey, id);
      return { id } as never;
    },
    created: () => [...values.keys()],
  };
}
