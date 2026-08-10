import { sha256 } from "../writing/task";
import { inspectMdx } from "../writing/mdx";
import type {
  ArticleDraftRepository,
  DraftQualityRepository,
} from "../writing/interfaces";
import type { ResearchPacketRepository } from "../research/interfaces";
import type { ReviewConfig } from "./config";
import { assertFinalApprovalEligibility } from "./eligibility";
import type {
  EditorialReviewRepository,
  FinalApprovedEventRepository,
  FinalApprovalRepository,
  ReviewGateRepository,
  RevisionTaskRepository,
} from "./interfaces";
import {
  articleFinalApprovedEventSchema,
  finalApprovalRecordSchema,
  type FinalApprovalRecord,
} from "./models";

export interface FinalActor {
  telegramChatId: string;
  telegramUserId: string;
  telegramUpdateId: number;
  telegramMessageId?: number;
  callbackQueryId?: string;
}

export interface FinalApprovalDependencies {
  drafts: ArticleDraftRepository;
  quality: DraftQualityRepository;
  packets: ResearchPacketRepository;
  reviews: EditorialReviewRepository;
  revisions: RevisionTaskRepository;
  approvals: FinalApprovalRepository;
  events: FinalApprovedEventRepository;
  gates: ReviewGateRepository;
  config: ReviewConfig;
  clock?: () => Date;
}

export class FinalApprovalService {
  constructor(private deps: FinalApprovalDependencies) {}
  private now() {
    return (this.deps.clock ?? (() => new Date()))();
  }

  async status(topicId: string) {
    const approval = await this.deps.approvals.get(topicId);
    return { approval, event: await this.deps.events.get(topicId) };
  }

  async ensurePending(
    topicId: string,
    draftVersion: number,
    reviewVersion: number,
    actor: FinalActor,
  ) {
    const inputs = await this.eligible(topicId, draftVersion, reviewVersion);
    const current = await this.deps.approvals.get(topicId);
    if (
      current?.draftVersion === draftVersion &&
      current.reviewVersion === reviewVersion &&
      current.status === "pending"
    )
      return current;
    const now = this.now().toISOString();
    const value = finalApprovalRecordSchema.parse({
      id: `finalapproval_${sha256(`${topicId}:${draftVersion}:${reviewVersion}`).slice(0, 24)}`,
      shortId: sha256(`${topicId}:${draftVersion}:${reviewVersion}`).slice(
        0,
        12,
      ),
      topicId,
      draftId: inputs.draft.id,
      draftVersion,
      reviewId: inputs.review.id,
      reviewVersion,
      telegramChatId: actor.telegramChatId,
      telegramUserId: actor.telegramUserId,
      status: "pending",
      approvalNotes: [],
      createdAt: now,
      updatedAt: now,
      telegramUpdateId: actor.telegramUpdateId,
      telegramMessageId: actor.telegramMessageId,
      version: (current?.version ?? 0) + 1,
    });
    await this.deps.approvals.save(value);
    return value;
  }

  async act(
    topicId: string,
    draftVersion: number,
    reviewVersion: number,
    action: NonNullable<FinalApprovalRecord["action"]>,
    actor: FinalActor,
    options: { notes?: string[]; scheduledFor?: string } = {},
  ) {
    const current = await this.deps.approvals.get(topicId);
    if (
      current?.telegramUpdateId === actor.telegramUpdateId &&
      current.callbackQueryId === actor.callbackQueryId
    )
      return {
        approval: current,
        event: await this.deps.events.get(topicId),
        reused: true,
      };
    const inputs = await this.eligible(topicId, draftVersion, reviewVersion);
    let scheduled: { at: string; timezone: string } | undefined;
    if (action === "approve_schedule") {
      if (!options.scheduledFor) throw new Error("A schedule time is required");
      scheduled = normalizeSchedule(
        options.scheduledFor,
        this.now(),
        this.deps.config.scheduleHorizonDays,
      );
    }
    const status = {
      approve_publish: "approved",
      approve_schedule: "scheduled",
      request_changes: "changes_requested",
      hold: "held",
      reject: "rejected",
    }[action] as FinalApprovalRecord["status"];
    const now = this.now().toISOString();
    const approval = finalApprovalRecordSchema.parse({
      id:
        current?.id ??
        `finalapproval_${sha256(`${topicId}:${draftVersion}:${reviewVersion}`).slice(0, 24)}`,
      shortId:
        current?.shortId ??
        sha256(`${topicId}:${draftVersion}:${reviewVersion}`).slice(0, 12),
      topicId,
      draftId: inputs.draft.id,
      draftVersion,
      reviewId: inputs.review.id,
      reviewVersion,
      telegramChatId: actor.telegramChatId,
      telegramUserId: actor.telegramUserId,
      status,
      action,
      approvalNotes: options.notes ?? [],
      scheduledAt: scheduled?.at,
      scheduleTimezone: scheduled?.timezone,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      telegramUpdateId: actor.telegramUpdateId,
      telegramMessageId: actor.telegramMessageId ?? current?.telegramMessageId,
      callbackQueryId: actor.callbackQueryId,
      version: (current?.version ?? 0) + 1,
    });
    let event = await this.deps.events.get(topicId);
    if (action === "approve_publish" || action === "approve_schedule") {
      const origin = await this.deps.gates.topicOrigin(topicId);
      if (!origin) throw new Error("Topic origin is unavailable");
      const next = articleFinalApprovedEventSchema.parse({
        id:
          event?.id ??
          `articleevent_${sha256(`${topicId}:${draftVersion}:${reviewVersion}`).slice(0, 24)}`,
        topicId,
        candidateId: inputs.draft.candidateId,
        draftId: inputs.draft.id,
        draftVersion,
        reviewId: inputs.review.id,
        reviewVersion,
        researchPacketId: inputs.draft.researchPacketId,
        researchPacketVersion: inputs.draft.researchPacketVersion,
        approvedAt: now,
        approvedBy: {
          telegramUserId: actor.telegramUserId,
          telegramChatId: actor.telegramChatId,
        },
        approvalNotes: approval.approvalNotes,
        requestedPublishAt: scheduled?.at,
        requestedTimezone: scheduled?.timezone,
        articleSnapshotHash: sha256(
          JSON.stringify({
            draft: inputs.draft,
            reviewId: inputs.review.id,
            reviewVersion: inputs.review.version,
            decision: inputs.review.decision,
          }),
        ),
        sourceIds: inputs.draft.sourceIds,
        origin,
        status: scheduled ? "scheduled" : "ready_for_publication",
        createdAt: now,
        version: (event?.version ?? 0) + 1,
      });
      if (this.deps.approvals.saveWithEvent) {
        if (
          !(await this.deps.approvals.saveWithEvent(
            approval,
            next,
            event?.version,
          ))
        )
          throw new Error("A final-approved event was created concurrently");
      } else {
        await this.deps.approvals.save(approval);
        if (event) await this.deps.events.update(next, event.version);
        else if (!(await this.deps.events.save(next)))
          throw new Error("A final-approved event was created concurrently");
      }
      event = next;
    } else {
      await this.deps.approvals.save(approval);
    }
    return { approval, event, reused: false };
  }

  async cancel(
    topicId: string,
    actor: FinalActor,
    note = "Final approval cancelled",
  ) {
    const current = await this.deps.approvals.get(topicId);
    if (!current) throw new Error("Final approval does not exist");
    if (current.status === "cancelled")
      return {
        approval: current,
        event: await this.deps.events.get(topicId),
        reused: true,
      };
    const now = this.now().toISOString();
    const approval = finalApprovalRecordSchema.parse({
      ...current,
      status: "cancelled",
      approvalNotes: [...current.approvalNotes, note],
      updatedAt: now,
      telegramUpdateId: actor.telegramUpdateId,
      callbackQueryId: actor.callbackQueryId,
      version: current.version + 1,
    });
    await this.deps.approvals.save(approval);
    let event = await this.deps.events.get(topicId);
    if (
      event &&
      !["cancelled", "superseded", "consumed"].includes(event.status)
    ) {
      const next = articleFinalApprovedEventSchema.parse({
        ...event,
        status: "cancelled",
        createdAt: now,
        version: event.version + 1,
      });
      await this.deps.events.update(next, event.version);
      event = next;
    }
    return { approval, event, reused: false };
  }

  private async eligible(
    topicId: string,
    draftVersion: number,
    reviewVersion: number,
  ) {
    const [draft, latest, quality, review, pendingRevision] = await Promise.all(
      [
        this.deps.drafts.get(topicId, draftVersion),
        this.deps.drafts.get(topicId),
        this.deps.quality.get(topicId, draftVersion),
        this.deps.reviews.get(topicId, draftVersion, reviewVersion),
        this.deps.revisions.getRequest(topicId, draftVersion),
      ],
    );
    const packet = draft
      ? await this.deps.packets.get(topicId, draft.researchPacketVersion)
      : undefined;
    const latestPacket = await this.deps.packets.get(topicId);
    const topicActive = draft
      ? await this.deps.gates.topicActive(topicId, draft.approvedEventId)
      : false;
    const input = {
      draft,
      latestDraftVersion: latest?.version ?? 0,
      review,
      quality,
      packet,
      topicActive,
      minimumCitationCoverage: this.deps.config.minimumCitationCoverage,
      pendingRevision: Boolean(
        pendingRevision &&
        ["pending", "task_ready"].includes(pendingRevision.status),
      ),
      latestResearchPacketVersion: latestPacket?.version,
    };
    assertFinalApprovalEligibility(input);
    if (
      inspectMdx(input.draft.mdx, new Set(input.draft.sourceIds)).safetyIssues
        .length
    )
      throw new Error("Final approval is not eligible: MDX safety failed");
    const event = await this.deps.events.get(topicId);
    if (event?.status === "consumed")
      throw new Error("Final approval event was already consumed");
    if (
      input.review.draftId !== input.draft.id ||
      input.review.draftVersion !== draftVersion ||
      input.review.researchPacketId !== input.draft.researchPacketId ||
      input.review.researchPacketVersion !== input.draft.researchPacketVersion
    )
      throw new Error(
        "Review does not bind to the exact draft and research packet",
      );
    return input;
  }
}

export function normalizeSchedule(
  value: string,
  now: Date,
  horizonDays: number,
) {
  const explicit = /(?:Z|[+-]\d\d:\d\d)$/.test(value);
  if (
    !(explicit
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        )
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
  )
    throw new Error("Invalid schedule time");
  const [datePart] = value.split("T");
  const [year, month, day] = (datePart ?? "").split("-").map(Number);
  const calendarCheck = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() + 1 !== month ||
    calendarCheck.getUTCDate() !== day
  )
    throw new Error("Invalid schedule time");
  const normalized = explicit ? value : `${value}:00-07:00`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.valueOf()))
    throw new Error("Invalid schedule time");
  if (date <= now) throw new Error("Schedule time must be in the future");
  if (date.valueOf() > now.valueOf() + horizonDays * 86_400_000)
    throw new Error("Schedule time exceeds the configured horizon");
  return {
    at: date.toISOString(),
    timezone: explicit ? "explicit-offset" : "America/Phoenix",
  };
}
