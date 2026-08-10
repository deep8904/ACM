import { describe, expect, it } from "vitest";
import type { ResearchPacketRepository } from "../../research/interfaces";
import type {
  ArticleDraftRepository,
  DraftQualityRepository,
} from "../../writing/interfaces";
import { reviewConfigSchema } from "../config";
import { FinalApprovalService } from "../final-approval";
import type {
  EditorialReviewRepository,
  FinalApprovedEventRepository,
  FinalApprovalRepository,
  ReviewGateRepository,
  RevisionTaskRepository,
} from "../interfaces";
import type { ArticleFinalApprovedEvent, FinalApprovalRecord } from "../models";

describe("offline final approval event flow", () => {
  it("approves once, reschedules the unconsumed event, and cancels it", async () => {
    const draft = {
      id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      topicId: "topic_fixture",
      candidateId: "candidate_fixture",
      researchPacketId: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
      researchPacketVersion: 1,
      approvedEventId: "event_aaaaaaaaaaaaaaaaaaaaaaaa",
      version: 1,
      status: "validated",
      draft: true,
      publishedAt: null,
      canonicalUrl: null,
      heroImage: null,
      mdx: "Validated source-linked article. [source:source_aaaaaaaaaaaaaaaaaaaaaaaa]",
      sourceIds: ["source_aaaaaaaaaaaaaaaaaaaaaaaa"],
      researchContentHashes: ["a".repeat(64)],
    };
    const quality = { status: "passed", citationCoverage: { score: 100 } };
    const packet = {
      id: draft.researchPacketId,
      version: 1,
      status: "ready",
      sufficient: true,
      blockingReasons: [],
      contentHashes: draft.researchContentHashes,
    };
    const review = {
      id: "review_aaaaaaaaaaaaaaaaaaaaaaaa",
      version: 1,
      draftId: draft.id,
      draftVersion: 1,
      researchPacketId: packet.id,
      researchPacketVersion: 1,
      decision: "pass",
      issues: [],
      riskSummary: { overall: "low" },
    };
    const approvals: FinalApprovalRecord[] = [];
    const events: ArticleFinalApprovedEvent[] = [];
    const approvalRepo = {
      get: async () => approvals.at(-1),
      getByShortId: async (id: string) =>
        approvals.find((x) => x.shortId === id),
      save: async (value: FinalApprovalRecord) => {
        approvals.push(value);
      },
      list: async () => approvals,
    } satisfies FinalApprovalRepository;
    const eventRepo = {
      get: async () => events.at(-1),
      save: async (value: ArticleFinalApprovedEvent) => {
        if (events.length) return false;
        events.push(value);
        return true;
      },
      update: async (value: ArticleFinalApprovedEvent, expected: number) => {
        expect(events.at(-1)?.version).toBe(expected);
        events.push(value);
      },
    } satisfies FinalApprovedEventRepository;
    const service = new FinalApprovalService({
      drafts: {
        get: async () => draft,
        nextVersion: async () => 2,
      } as unknown as ArticleDraftRepository,
      quality: {
        get: async () => quality,
      } as unknown as DraftQualityRepository,
      packets: {
        get: async () => packet,
      } as unknown as ResearchPacketRepository,
      reviews: {
        get: async () => review,
      } as unknown as EditorialReviewRepository,
      revisions: {
        getRequest: async () => undefined,
      } as unknown as RevisionTaskRepository,
      approvals: approvalRepo,
      events: eventRepo,
      gates: {
        topicActive: async () => true,
        topicOrigin: async () => "manual_topic",
      } as unknown as ReviewGateRepository,
      config: reviewConfigSchema.parse({}),
      clock: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    const actor = {
      telegramChatId: "100",
      telegramUserId: "200",
      telegramUpdateId: 1,
    };
    const approved = await service.act(
      "topic_fixture",
      1,
      1,
      "approve_publish",
      actor,
    );
    const replay = await service.act(
      "topic_fixture",
      1,
      1,
      "approve_publish",
      actor,
    );
    expect(replay.reused).toBe(true);
    expect(events).toHaveLength(1);
    expect(approved.event?.status).toBe("ready_for_publication");
    expect(approved.event?.status).not.toBe("consumed");
    const scheduled = await service.act(
      "topic_fixture",
      1,
      1,
      "approve_schedule",
      { ...actor, telegramUpdateId: 2 },
      { scheduledFor: "2026-08-07T09:30" },
    );
    expect(scheduled.event?.status).toBe("scheduled");
    expect(scheduled.event?.articleSnapshotHash).toBe(
      approved.event?.articleSnapshotHash,
    );
    expect(events).toHaveLength(2);
    const cancelled = await service.cancel("topic_fixture", {
      ...actor,
      telegramUpdateId: 3,
    });
    expect(cancelled.event?.status).toBe("cancelled");
    expect(events).toHaveLength(3);
  });
});
