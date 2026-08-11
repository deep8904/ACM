import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  withTransaction,
  type DatabaseClient,
  type DatabaseTransaction,
} from "../database/client";
import { toJsonValue } from "../database/json";
import type { TelegramActor } from "../telegram/authorization";
import { TelegramControlError } from "../telegram/errors";
import type {
  EditorialNotificationAdapter,
  TopicApprovalRepository,
} from "../telegram/interfaces";
import { topicQueueItemSchema, type TelegramUpdate } from "../telegram/models";
import type { FinalReviewControl } from "../telegram/service";
import {
  ResearchService,
  ResearchSourceInspectionError,
  type ResearchSourceExtensionInput,
} from "./service";
import type {
  ApprovedEventRepository,
  ResearchPacketRepository,
} from "./interfaces";
import type { AutomationJob } from "../orchestration/models";
import { automationKey } from "../orchestration/reconcile";
import { PostgresAutomationJobRepository } from "../orchestration/repository";
import {
  InvalidResearchHandoffError,
  loadResearchHandoff,
} from "../orchestration/research-handoff";
import { DurableApprovedEventError } from "./approved-event";

export interface ActionableResearchRecovery {
  job: AutomationJob;
  topicId: string;
  title: string;
  packetVersion: number;
  reason: string;
}

const iso = z.string().datetime({ offset: true });
const proposalSchema = z
  .object({
    canonicalUrl: z.string().url(),
    title: z.string().min(1),
    publisher: z.string().min(1),
    publisherOwner: z.string().min(1),
    sourceType: z.enum([
      "official_announcement",
      "documentation",
      "release_notes",
      "repository",
      "technical_reporting",
      "general_reporting",
      "community_discussion",
      "product_page",
      "support_document",
      "regulatory_filing",
      "research_paper",
      "manual_url",
      "other",
    ]),
    proposedAuthority: z.enum(["primary", "independent"]),
    reason: z.string().min(1).max(1000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const retrievalFailureSchema = z
  .object({
    code: z.enum([
      "429_retry_after",
      "429_cooldown",
      "robots_denied",
      "403_forbidden",
      "no_retrievable_primary",
      "retrieval",
      "unsafe_url",
      "duplicate",
    ]),
    diagnosticId: z.string().regex(/^diag_[a-f0-9]{16}$/),
    retryAt: iso.optional(),
  })
  .strict();

export const researchRemediationSchema = z
  .object({
    id: z.string().regex(/^remediation_[a-f0-9]{24}$/),
    shortId: z.string().regex(/^[a-f0-9]{12}$/),
    chatId: z.string().regex(/^-?\d+$/),
    userId: z.string().regex(/^\d+$/),
    topicId: z.string().min(1),
    eventId: z.string().regex(/^event_[a-f0-9]{24}$/),
    jobId: z.string().regex(/^automationjob_[a-f0-9]{24}$/),
    packetVersion: z.number().int().positive(),
    state: z.enum([
      "blocked",
      "awaiting_url",
      "awaiting_classification",
      "queued",
      "cancelled",
      "superseded",
      "failed",
    ]),
    reason: z.string().min(1).max(1000),
    proposal: proposalSchema.optional(),
    pendingUrl: z.string().url().optional(),
    retrievalFailure: retrievalFailureSchema.optional(),
    createdAt: iso,
    updatedAt: iso,
    expiresAt: iso,
    version: z.number().int().positive(),
  })
  .strict();
export type ResearchRemediation = z.infer<typeof researchRemediationSchema>;
export type ResearchSourceProposal = z.infer<typeof proposalSchema>;

export interface ResearchRemediationRepository {
  getByShortId(shortId: string): Promise<ResearchRemediation | undefined>;
  getForActor(
    chatId: string,
    userId: string,
  ): Promise<ResearchRemediation | undefined>;
  getForJobActor(
    jobId: string,
    chatId: string,
    userId: string,
  ): Promise<ResearchRemediation | undefined>;
  save(
    value: ResearchRemediation,
    expectedVersion?: number,
  ): Promise<ResearchRemediation>;
  cancelInteraction(
    value: ResearchRemediation,
    expectedVersion: number,
    dedupeKey: string,
    fromState: ResearchRemediation["state"],
  ): Promise<ResearchRemediation>;
  audit(input: {
    remediationId: string;
    topicId: string;
    jobId: string;
    action: string;
    diagnosticId?: string;
    dedupeKey: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

export class PostgresResearchRemediationRepository implements ResearchRemediationRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async getByShortId(shortId: string) {
    const rows = await this.sql<{ payload: unknown }[]>`
      select payload from content_machine.research_remediation_conversations
      where short_id=${shortId}
    `;
    return rows[0]
      ? researchRemediationSchema.parse(rows[0].payload)
      : undefined;
  }

  async getForActor(chatId: string, userId: string) {
    const rows = await this.sql<{ payload: unknown }[]>`
      select payload from content_machine.research_remediation_conversations
      where chat_id=${chatId} and user_id=${userId}
    `;
    return rows[0]
      ? researchRemediationSchema.parse(rows[0].payload)
      : undefined;
  }

  async getForJobActor(jobId: string, chatId: string, userId: string) {
    const rows = await this.sql<{ payload: unknown }[]>`
      select payload from content_machine.research_remediation_conversations
      where job_id=${jobId} and chat_id=${chatId} and user_id=${userId}
    `;
    return rows[0]
      ? researchRemediationSchema.parse(rows[0].payload)
      : undefined;
  }

  async save(value: ResearchRemediation, expectedVersion?: number) {
    const item = researchRemediationSchema.parse(value);
    if (expectedVersion === undefined) {
      await this.sql`
        insert into content_machine.research_remediation_conversations
          (id,short_id,chat_id,user_id,topic_id,event_id,job_id,packet_version,state,reason,version,expires_at,payload,created_at,updated_at)
        values (${item.id},${item.shortId},${item.chatId},${item.userId},${item.topicId},${item.eventId},${item.jobId},${item.packetVersion},${item.state},${item.reason},${item.version},${item.expiresAt},${this.sql.json(toJsonValue(item))},${item.createdAt},${item.updatedAt})
        on conflict (chat_id,user_id) do update set id=excluded.id,short_id=excluded.short_id,
          topic_id=excluded.topic_id,event_id=excluded.event_id,job_id=excluded.job_id,
          packet_version=excluded.packet_version,state=excluded.state,reason=excluded.reason,
          version=excluded.version,expires_at=excluded.expires_at,payload=excluded.payload,
          created_at=excluded.created_at,updated_at=excluded.updated_at
      `;
      return item;
    }
    const rows = await this.sql<{ id: string }[]>`
      update content_machine.research_remediation_conversations
      set id=${item.id},short_id=${item.shortId},topic_id=${item.topicId},
        event_id=${item.eventId},job_id=${item.jobId},
        packet_version=${item.packetVersion},state=${item.state},reason=${item.reason},
        version=${item.version},expires_at=${item.expiresAt},payload=${this.sql.json(toJsonValue(item))},
        created_at=${item.createdAt},updated_at=${item.updatedAt}
      where chat_id=${item.chatId} and user_id=${item.userId} and version=${expectedVersion}
      returning id
    `;
    if (!rows[0])
      throw new TelegramControlError(
        "queue_conflict",
        "Research recovery state changed. Use /status to refresh.",
        409,
      );
    return item;
  }

  async audit(input: Parameters<ResearchRemediationRepository["audit"]>[0]) {
    await this.writeAudit(this.sql, input);
  }

  async cancelInteraction(
    value: ResearchRemediation,
    expectedVersion: number,
    dedupeKey: string,
    fromState: ResearchRemediation["state"],
  ) {
    const item = researchRemediationSchema.parse(value);
    await withTransaction(this.sql, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update content_machine.research_remediation_conversations
        set packet_version=${item.packetVersion},state=${item.state},reason=${item.reason},
          version=${item.version},expires_at=${item.expiresAt},payload=${tx.json(toJsonValue(item))},
          updated_at=${item.updatedAt}
        where id=${item.id} and version=${expectedVersion}
        returning id
      `;
      if (!rows[0])
        throw new TelegramControlError(
          "queue_conflict",
          "Research recovery state changed. Use /jobs to refresh.",
          409,
        );
      await this.writeAudit(tx, {
        remediationId: item.id,
        topicId: item.topicId,
        jobId: item.jobId,
        action: "interaction_cancelled",
        dedupeKey,
        details: { fromState },
      });
    });
    return item;
  }

  private async writeAudit(
    sql: DatabaseClient | DatabaseTransaction,
    input: Parameters<ResearchRemediationRepository["audit"]>[0],
  ) {
    const id = `remediationevent_${hash(`${input.remediationId}:${input.action}:${input.dedupeKey}`).slice(0, 24)}`;
    await sql`
      insert into content_machine.research_remediation_events
        (id,remediation_id,topic_id,job_id,action,diagnostic_id,payload)
      values (${id},${input.remediationId},${input.topicId},${input.jobId},${input.action},${input.diagnosticId ?? null},${sql.json(toJsonValue(input.details ?? {}))})
      on conflict(id) do nothing
    `;
  }
}

export class ResearchRemediationService {
  constructor(
    private readonly deps: {
      remediation: ResearchRemediationRepository;
      research: ResearchService;
      packets: ResearchPacketRepository;
      events: ApprovedEventRepository;
      topics: TopicApprovalRepository;
      jobs: PostgresAutomationJobRepository;
      now?: () => Date;
      ttlMinutes?: number;
    },
  ) {}

  async openBlocked(job: AutomationJob, actor: TelegramActor, reason?: string) {
    const { packet } = await this.assertRecoverable(job);
    const now = this.now();
    const identity = hash(`${job.id}:${actor.chatId}:${actor.userId}`);
    const existing = await this.deps.remediation.getForActor(
      actor.chatId,
      actor.userId,
    );
    const value = researchRemediationSchema.parse({
      id: `remediation_${identity.slice(0, 24)}`,
      shortId: identity.slice(0, 12),
      chatId: actor.chatId,
      userId: actor.userId,
      topicId: packet.topicId,
      eventId: packet.approvedEventId,
      jobId: job.id,
      packetVersion: packet.version,
      state: "blocked",
      reason: conciseReason(
        reason ?? packet.blockingReasons[0] ?? "Evidence is insufficient",
      ),
      createdAt:
        existing?.id === `remediation_${identity.slice(0, 24)}`
          ? existing.createdAt
          : now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (this.deps.ttlMinutes ?? 30) * 60_000,
      ).toISOString(),
      version: (existing?.version ?? 0) + 1,
    });
    const queue = await this.deps.topics.getQueueItem(packet.topicId);
    if (queue && queue.researchReadiness !== "awaiting_source")
      await this.deps.topics.saveQueueItem(
        topicQueueItemSchema.parse({
          ...queue,
          researchReadiness: "awaiting_source",
          updatedAt: now.toISOString(),
          version: queue.version + 1,
        }),
        queue.version,
      );
    await this.deps.remediation.save(value, existing?.version);
    await this.deps.remediation.audit({
      remediationId: value.id,
      topicId: value.topicId,
      jobId: value.jobId,
      action: "opened",
      dedupeKey: `${job.id}:${value.version}`,
      details: { packetVersion: packet.version, reason: value.reason },
    });
    return value;
  }

  async openTopic(topicId: string, actor: TelegramActor) {
    const jobs = await this.deps.jobs.list(["blocked"], 100);
    const job = jobs.find(
      (candidate) =>
        candidate.type === "research" && candidate.topicId === topicId,
    );
    if (!job)
      throw new TelegramControlError(
        "invalid_state_transition",
        "That topic is not awaiting a research source.",
        409,
      );
    return this.openBlocked(job, actor, job.failureSummary);
  }

  async listActionableBlocked(limit = 100) {
    const jobs = await this.deps.jobs.list(["blocked"], limit);
    const seenEvents = new Set<string>();
    const actionable: ActionableResearchRecovery[] = [];
    for (const job of jobs) {
      const context = await this.recoverableContext(job);
      if (!context || seenEvents.has(context.event.id)) continue;
      seenEvents.add(context.event.id);
      actionable.push({
        job,
        topicId: context.packet.topicId,
        title: context.queue.candidateSnapshot.candidate.title,
        packetVersion: context.packet.version,
        reason: conciseReason(
          job.failureSummary ??
            context.packet.blockingReasons[0] ??
            "Evidence is insufficient",
        ),
      });
    }
    return actionable;
  }

  async resume(jobId: string, actor: TelegramActor) {
    const job = await this.deps.jobs.get(jobId);
    if (!job || !(await this.recoverableContext(job)))
      throw new TelegramControlError(
        "invalid_state_transition",
        "That research recovery is no longer available. Run /jobs again.",
        409,
      );
    return this.openBlocked(job, actor, job.failureSummary);
  }

  async inspect(state: ResearchRemediation, url: string) {
    await this.assertCurrent(state, ["awaiting_url"]);
    try {
      return proposalSchema.parse(
        await this.deps.research.inspectSource({ topicId: state.topicId, url }),
      );
    } catch (error) {
      if (
        error instanceof ResearchSourceInspectionError ||
        (error instanceof TelegramControlError && error.code === "invalid_url")
      ) {
        const category =
          error instanceof ResearchSourceInspectionError
            ? error.kind
            : "unsafe_url";
        const diagnosticId = `diag_${hash(`${state.id}:${category}:${this.now().toISOString()}`).slice(0, 16)}`;
        await this.deps.remediation.audit({
          remediationId: state.id,
          topicId: state.topicId,
          jobId: state.jobId,
          action: "source_rejected",
          diagnosticId,
          dedupeKey: diagnosticId,
          details: { category },
        });
        throw new ResearchRemediationInspectionError(
          `${error.message}. Reference: ${diagnosticId}`,
          category,
          diagnosticId,
          error instanceof ResearchSourceInspectionError
            ? error.retryAt
            : undefined,
        );
      }
      throw error;
    }
  }

  async confirm(
    state: ResearchRemediation,
    authority: "primary" | "independent",
    dedupeKey: string,
  ) {
    await this.assertCurrent(state, ["awaiting_classification"]);
    if (!state.proposal) throw new Error("Source proposal is missing");
    const input: ResearchSourceExtensionInput = {
      topicId: state.topicId,
      url: state.proposal.canonicalUrl,
      authority,
      sourceType:
        authority === "primary"
          ? state.proposal.sourceType
          : "technical_reporting",
      publisher: state.proposal.publisher,
      publisherOwner: state.proposal.publisherOwner,
    };
    const packet = await this.deps.research.extendSource(input);
    const queue = await this.deps.topics.getQueueItem(state.topicId);
    if (!queue) throw new Error("Topic queue lineage is missing");
    if (queue.researchReadiness === "awaiting_source")
      await this.deps.topics.saveQueueItem(
        topicQueueItemSchema.parse({
          ...queue,
          researchReadiness: "ready_for_research",
          updatedAt: this.now().toISOString(),
          version: queue.version + 1,
        }),
        queue.version,
      );
    const job = await this.deps.jobs.enqueue({
      type: "research",
      idempotencyKey: automationKey(
        `research-remediation:${state.eventId}:${packet.version}`,
      ),
      lineageKey: state.eventId,
      topicId: state.topicId,
      parentJobId: state.jobId,
      payload: {
        eventId: state.eventId,
        remediationId: state.id,
        packetVersion: packet.version,
      },
    });
    await this.deps.remediation.audit({
      remediationId: state.id,
      topicId: state.topicId,
      jobId: state.jobId,
      action: `confirmed_${authority}`,
      dedupeKey,
      details: { packetVersion: packet.version, recoveryJobId: job.id },
    });
    return { packet, job };
  }

  async scheduleRetry(state: ResearchRemediation, dedupeKey: string) {
    await this.assertCurrent(state, ["blocked"]);
    if (!state.pendingUrl || !state.retrievalFailure)
      throw new TelegramControlError(
        "invalid_state_transition",
        "There is no failed source request to retry.",
        409,
      );
    if (
      !["429_retry_after", "429_cooldown"].includes(state.retrievalFailure.code)
    )
      throw new TelegramControlError(
        "invalid_state_transition",
        "This failure is not retryable. Paste another official URL instead.",
        409,
      );
    const availableAt =
      state.retrievalFailure.retryAt ??
      new Date(this.now().getTime() + 30 * 60_000).toISOString();
    const job = await this.deps.jobs.enqueue({
      type: "research",
      idempotencyKey: automationKey(
        `research-source-retry:${state.id}:${state.pendingUrl}:${state.retrievalFailure.diagnosticId}`,
      ),
      lineageKey: state.eventId,
      topicId: state.topicId,
      parentJobId: state.jobId,
      maximumAttempts: 1,
      availableAt,
      payload: {
        eventId: state.eventId,
        remediationId: state.id,
        remediationShortId: state.shortId,
        remediationAction: "retry_source",
      },
    });
    await this.deps.remediation.audit({
      remediationId: state.id,
      topicId: state.topicId,
      jobId: state.jobId,
      action: "retry_later_scheduled",
      dedupeKey,
      diagnosticId: state.retrievalFailure.diagnosticId,
      details: { retryJobId: job.id, availableAt },
    });
    return job;
  }

  async findOfficialAlternatives(
    state: ResearchRemediation,
    dedupeKey: string,
  ) {
    await this.assertCurrent(state, ["blocked"]);
    if (!state.pendingUrl)
      throw new TelegramControlError(
        "invalid_state_transition",
        "There is no failed official URL to use for discovery.",
        409,
      );
    const alternatives = await this.deps.research.findOfficialAlternatives({
      topicId: state.topicId,
      url: state.pendingUrl,
    });
    await this.deps.remediation.audit({
      remediationId: state.id,
      topicId: state.topicId,
      jobId: state.jobId,
      action: alternatives.length
        ? "alternate_official_found"
        : "no_retrievable_primary",
      dedupeKey,
      diagnosticId: state.retrievalFailure?.diagnosticId,
      details: { count: alternatives.length },
    });
    return alternatives;
  }

  async cancelJob(state: ResearchRemediation, dedupeKey: string) {
    const job = await this.deps.jobs.get(state.jobId);
    if (
      job &&
      ["queued", "retryable", "blocked", "failed"].includes(job.status)
    )
      await this.deps.jobs.cancel(job.id);
    await this.deps.remediation.audit({
      remediationId: state.id,
      topicId: state.topicId,
      jobId: state.jobId,
      action: "cancelled",
      dedupeKey,
    });
  }

  private async recoverableContext(job: AutomationJob) {
    if (job.type !== "research" || job.status !== "blocked") return;
    let event;
    try {
      event = await loadResearchHandoff(job, this.deps.events);
    } catch (error) {
      if (
        error instanceof InvalidResearchHandoffError ||
        error instanceof DurableApprovedEventError
      )
        return;
      throw error;
    }
    const packet = await this.deps.packets.get(event.topicId);
    if (
      !packet ||
      packet.approvedEventId !== event.id ||
      packet.sufficient ||
      (!packet.blockingReasons.some((reason) =>
        /primary source/i.test(reason),
      ) &&
        typeof job.payload.remediationId !== "string")
    )
      return;
    const queue = await this.deps.events.queue(event.topicId);
    if (
      !queue ||
      queue.approvalStatus !== "approved" ||
      !["ready_for_research", "awaiting_source"].includes(
        queue.researchReadiness,
      ) ||
      !(await this.deps.events.isConsumed(event.id))
    )
      return;
    return { event, packet, queue };
  }

  private async assertRecoverable(job: AutomationJob) {
    const context = await this.recoverableContext(job);
    if (!context)
      throw new Error("Research block is not eligible for source remediation");
    return context;
  }

  private async assertCurrent(
    state: ResearchRemediation,
    allowed: ResearchRemediation["state"][],
  ) {
    if (!allowed.includes(state.state))
      throw new TelegramControlError(
        "stale_callback",
        "This research recovery action was already completed.",
        409,
      );
    if (Date.parse(state.expiresAt) <= this.now().getTime())
      throw new TelegramControlError(
        "stale_callback",
        "This research recovery request expired. Open it again from /jobs.",
        409,
      );
    const job = await this.deps.jobs.get(state.jobId);
    if (!job) throw new Error("Research recovery job is missing");
    await this.assertRecoverable(job);
  }

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }
}

const commands = new Set(["/add_source", "/research_source"]);
const staleCardMessage = "This card is stale; request a new one.";
type CallbackAction =
  | "add"
  | "change"
  | "cancel"
  | "confirm_topic_cancel"
  | "keep_topic"
  | "primary"
  | "independent"
  | "details"
  | "retry_later"
  | "find_official"
  | "paste_another"
  | "resume";

export class ResearchRemediationTelegramController implements FinalReviewControl {
  constructor(
    private readonly deps: {
      service: ResearchRemediationService;
      repository: ResearchRemediationRepository;
      adapter: EditorialNotificationAdapter;
      callbackSecret: string;
      cancelTopic: (
        topicId: string,
        update: TelegramUpdate,
        actor: TelegramActor,
      ) => Promise<void>;
      refreshTopics: (chatId: string) => Promise<void>;
      now?: () => Date;
      logger?: (
        level: "warn",
        message: string,
        details: Record<string, unknown>,
      ) => void;
    },
  ) {}

  handlesCommand(command: string | undefined) {
    return Boolean(command && commands.has(command));
  }

  async processCommand(
    _command: string,
    rest: string,
    _update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    const topicId = rest.trim();
    if (!topicId)
      throw new TelegramControlError(
        "invalid_command",
        "Usage: /add_source topic_id",
      );
    const state = await this.deps.service.openTopic(topicId, actor);
    await this.promptForUrl(state);
  }

  async notifyBlocked(
    job: AutomationJob,
    actor: TelegramActor,
    reason?: string,
  ) {
    const state = await this.deps.service.openBlocked(job, actor, reason);
    await this.deps.adapter.sendFinalReviewCard(
      actor.chatId,
      blockedCard(state, this.deps.callbackSecret),
    );
  }

  async showActionableJobs(actor: TelegramActor) {
    const actionable = await this.deps.service.listActionableBlocked();
    if (!actionable.length) {
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        "<b>No actionable automation jobs</b>\nUse /jobs all to view automation history.",
      );
      return;
    }
    for (const item of actionable)
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        resumeCard(item, actor, this.deps.callbackSecret),
      );
  }

  async processScheduledRetry(job: AutomationJob) {
    const shortId = job.payload.remediationShortId;
    if (
      job.payload.remediationAction !== "retry_source" ||
      typeof shortId !== "string"
    )
      throw new Error("Scheduled remediation retry payload is invalid");
    const state = await this.deps.repository.getByShortId(shortId);
    if (!state || !state.pendingUrl || state.state !== "blocked")
      return { skipped: true, reason: "remediation_state_advanced" };
    const pendingUrl = state.pendingUrl;
    const awaiting = await this.transition(state, "awaiting_url");
    try {
      const proposal = await this.deps.service.inspect(awaiting, pendingUrl);
      const next = await this.transition(awaiting, "awaiting_classification", {
        proposal,
        pendingUrl: undefined,
        retrievalFailure: undefined,
      });
      await this.deps.adapter.sendFinalReviewCard(
        next.chatId,
        classificationCard(next, this.deps.callbackSecret),
      );
      return { skipped: false, proposalReady: true };
    } catch (error) {
      if (!(error instanceof ResearchRemediationInspectionError)) throw error;
      const next = await this.transition(awaiting, "blocked", {
        proposal: undefined,
        retrievalFailure: {
          code: error.category,
          diagnosticId: error.diagnosticId,
          retryAt: error.retryAt,
        },
      });
      await this.deps.adapter.sendFinalReviewCard(
        next.chatId,
        retrievalRecoveryCard(next, this.deps.callbackSecret),
      );
      return { skipped: false, proposalReady: false };
    }
  }

  async processCallback(update: TelegramUpdate, actor: TelegramActor) {
    const query = update.callback_query;
    if (!query?.data)
      throw new TelegramControlError(
        "stale_callback",
        "Missing recovery action",
      );
    let parsed: ReturnType<typeof parseCallback>;
    try {
      parsed = parseCallback(query.data, this.deps.callbackSecret, actor);
    } catch (error) {
      if (error instanceof RemediationCallbackError)
        this.logStale(error.condition, {
          callbackBytes: Buffer.byteLength(query.data, "utf8"),
        });
      throw error;
    }
    if (parsed.action === "resume") {
      await this.deps.adapter.answerCallback(query.id);
      const state = await this.deps.service.resume(parsed.jobId, actor);
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        blockedCard(state, this.deps.callbackSecret),
      );
      return;
    }
    const state = await this.deps.repository.getByShortId(parsed.shortId);
    if (!state) {
      this.logStale("missing_durable_state", parsed);
      throw new TelegramControlError("stale_callback", staleCardMessage, 403);
    }
    if (state.chatId !== actor.chatId || state.userId !== actor.userId) {
      this.logStale("actor_mismatch", {
        ...parsed,
        durableVersion: state.version,
      });
      throw new TelegramControlError("stale_callback", staleCardMessage, 403);
    }
    if (
      parsed.action === "cancel" &&
      state.state === "blocked" &&
      state.version === parsed.version + 1
    ) {
      await this.deps.adapter.answerCallback(query.id);
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        blockedCard(state, this.deps.callbackSecret),
      );
      return;
    }
    if (state.version !== parsed.version) {
      this.logStale("version_mismatch", {
        ...parsed,
        durableVersion: state.version,
        packetVersion: state.packetVersion,
      });
      throw new TelegramControlError("stale_callback", staleCardMessage, 409);
    }
    if (Date.parse(state.expiresAt) <= this.now().getTime()) {
      this.logStale("expired", {
        ...parsed,
        durableVersion: state.version,
        expiresAt: state.expiresAt,
      });
      throw new TelegramControlError("stale_callback", staleCardMessage, 409);
    }
    await this.deps.adapter.answerCallback(query.id);
    if (parsed.action === "add" || parsed.action === "paste_another") {
      await this.promptForUrl(state);
    } else if (parsed.action === "retry_later") {
      const result = await this.deps.service.scheduleRetry(state, query.id);
      const next = await this.transition(state, "blocked", {
        expiresAt: new Date(
          Date.parse(result.availableAt) + 30 * 60_000,
        ).toISOString(),
      });
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        `<b>Retry scheduled</b>\nThe official URL will be checked once after the host cooldown, no earlier than ${escape(result.availableAt)}. No packet or source was added.`,
      );
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        blockedCard(next, this.deps.callbackSecret),
      );
    } else if (parsed.action === "find_official") {
      const alternatives = await this.deps.service.findOfficialAlternatives(
        state,
        query.id,
      );
      const next = await this.transition(state, "blocked");
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        alternatives.length
          ? `<b>Official alternatives found</b>\n${alternatives.map((url, index) => `${index + 1}. ${escape(url)}`).join("\n")}\n\nNothing was added. Tap Paste another URL and send the option you want to inspect and confirm.`
          : "<b>No retrievable official alternative found</b>\nThe verified publisher host is unavailable or in cooldown. The topic remains blocked; no third-party page was promoted to primary.",
      );
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        retrievalRecoveryCard(next, this.deps.callbackSecret),
      );
    } else if (parsed.action === "cancel") {
      const next = await this.cancelInteraction(state, query.id);
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        blockedCard(next, this.deps.callbackSecret),
      );
    } else if (parsed.action === "change") {
      const next = await this.transition(state, "blocked", {
        proposal: undefined,
      });
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        topicCancellationCard(next, this.deps.callbackSecret),
      );
    } else if (parsed.action === "keep_topic") {
      const next = await this.transition(state, "blocked", {
        proposal: undefined,
      });
      await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        blockedCard(next, this.deps.callbackSecret),
      );
    } else if (parsed.action === "details") {
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        `<b>Research recovery details</b>\nTopic: ${escape(state.topicId)}\nJob: ${escape(state.jobId)}\nPacket: v${state.packetVersion}\nReason: ${escape(state.reason)}`,
      );
    } else if (parsed.action === "primary" || parsed.action === "independent") {
      const result = await this.deps.service.confirm(
        state,
        parsed.action,
        query.id,
      );
      await this.transition(state, "queued", {
        packetVersion: result.packet.version,
      });
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        `<b>Source added ✓</b>\nImmutable research packet v${result.packet.version} created. Gemini synthesis is queued; the normal pipeline will continue only if evidence passes unchanged gates.`,
      );
    } else if (parsed.action === "confirm_topic_cancel") {
      await this.deps.cancelTopic(state.topicId, update, actor);
      await this.deps.service.cancelJob(state, query.id);
      await this.transition(state, "cancelled");
      await this.deps.refreshTopics(actor.chatId);
    }
  }

  async processConversationText(
    text: string,
    _update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    const state = await this.deps.repository.getForActor(
      actor.chatId,
      actor.userId,
    );
    if (!state || state.state !== "awaiting_url") return false;
    let proposal: ResearchSourceProposal;
    try {
      proposal = await this.deps.service.inspect(state, text);
    } catch (error) {
      if (error instanceof ResearchRemediationInspectionError) {
        const next = await this.transition(state, "blocked", {
          proposal: undefined,
          pendingUrl: text,
          retrievalFailure: {
            code: error.category,
            diagnosticId: error.diagnosticId,
            retryAt: error.retryAt,
          },
        });
        await this.deps.adapter.sendFinalReviewCard(
          actor.chatId,
          retrievalRecoveryCard(next, this.deps.callbackSecret),
        );
        return true;
      }
      if (error instanceof TelegramControlError) throw error;
      const diagnosticId = `diag_${hash(`${state.id}:continuation:${this.now().toISOString()}`).slice(0, 16)}`;
      try {
        await this.deps.repository.audit({
          remediationId: state.id,
          topicId: state.topicId,
          jobId: state.jobId,
          action: "source_inspection_failed",
          diagnosticId,
          dedupeKey: diagnosticId,
          details: {
            category: "internal",
            errorName:
              error instanceof Error ? error.name.slice(0, 100) : "unknown",
          },
        });
      } catch (auditError) {
        this.logContinuationFailure("diagnostic_write_failed", state, {
          diagnosticId,
          error: safeContinuationError(auditError),
        });
      }
      this.logContinuationFailure("source_inspection_failed", state, {
        diagnosticId,
        error: safeContinuationError(error),
      });
      throw new TelegramControlError(
        "invalid_url",
        `I couldn't inspect that URL right now. The request is still active; try again or send another public URL. Reference: ${diagnosticId}`,
        502,
      );
    }
    const next = await this.transition(state, "awaiting_classification", {
      proposal,
    });
    await this.deps.adapter.sendFinalReviewCard(
      actor.chatId,
      classificationCard(next, this.deps.callbackSecret),
    );
    return true;
  }

  private async promptForUrl(state: ResearchRemediation) {
    const next = await this.transition(state, "awaiting_url", {
      proposal: undefined,
      pendingUrl: undefined,
      retrievalFailure: undefined,
    });
    await this.deps.adapter.sendFinalReviewCard(
      next.chatId,
      inputCard(next, this.deps.callbackSecret),
    );
  }

  private async cancelInteraction(
    state: ResearchRemediation,
    dedupeKey: string,
  ) {
    const next = researchRemediationSchema.parse({
      ...state,
      proposal: undefined,
      pendingUrl: undefined,
      retrievalFailure: undefined,
      state: "blocked",
      updatedAt: this.now().toISOString(),
      version: state.version + 1,
    });
    return this.deps.repository.cancelInteraction(
      next,
      state.version,
      dedupeKey,
      state.state,
    );
  }

  private async transition(
    state: ResearchRemediation,
    nextState: ResearchRemediation["state"],
    changes: Partial<
      Pick<
        ResearchRemediation,
        | "proposal"
        | "packetVersion"
        | "pendingUrl"
        | "retrievalFailure"
        | "expiresAt"
      >
    > = {},
  ) {
    const next = researchRemediationSchema.parse({
      ...state,
      ...changes,
      state: nextState,
      updatedAt: this.now().toISOString(),
      version: state.version + 1,
    });
    return this.deps.repository.save(next, state.version);
  }

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private logStale(condition: string, details: Record<string, unknown>) {
    const logger =
      this.deps.logger ??
      ((level: "warn", message: string, value: Record<string, unknown>) =>
        console.warn(JSON.stringify({ level, message, ...value })));
    logger("warn", "research_remediation_callback_rejected", {
      condition,
      ...details,
    });
  }

  private logContinuationFailure(
    condition: string,
    state: ResearchRemediation,
    details: Record<string, unknown>,
  ) {
    const logger =
      this.deps.logger ??
      ((level: "warn", message: string, value: Record<string, unknown>) =>
        console.warn(JSON.stringify({ level, message, ...value })));
    logger("warn", "research_remediation_continuation_failed", {
      condition,
      remediationId: state.id,
      topicId: state.topicId,
      jobId: state.jobId,
      state: state.state,
      version: state.version,
      ...details,
    });
  }
}

function safeContinuationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]")
    .replace(/(key|token|secret)=[^\s&]+/gi, "$1=<redacted>")
    .replace(/bot\d{6,}:[A-Za-z0-9_-]+/g, "<redacted bot token>")
    .replace(/\b-?\d{6,}\b/g, "<redacted id>")
    .slice(0, 500);
}

function blockedCard(state: ResearchRemediation, secret: string) {
  return {
    topicId: state.topicId,
    text: `<b>Research blocked</b>\n${escape(state.reason)}\n\nNo article was drafted or published.`,
    buttons: [
      [button("Add primary source", "add", state, secret)],
      [button("Cancel approved topic…", "change", state, secret)],
      [button("Details", "details", state, secret)],
    ],
  };
}

function retrievalRecoveryCard(state: ResearchRemediation, secret: string) {
  const failure = state.retrievalFailure;
  if (!failure) throw new Error("Retrieval failure is missing");
  const retryable = ["429_retry_after", "429_cooldown"].includes(failure.code);
  return {
    topicId: state.topicId,
    text: `<b>Official source could not be retrieved</b>\nReason: ${escape(failure.code)}\nReference: ${escape(failure.diagnosticId)}${failure.retryAt ? `\nHost cooldown until: ${escape(failure.retryAt)}` : ""}\n\nThe topic remains blocked and no source was added.`,
    buttons: [
      ...(retryable
        ? [[button("Retry later", "retry_later", state, secret)]]
        : []),
      [button("Find another official source", "find_official", state, secret)],
      [button("Paste another URL", "paste_another", state, secret)],
      [button("Cancel source attempt", "cancel", state, secret)],
    ],
  };
}

function topicCancellationCard(state: ResearchRemediation, secret: string) {
  return {
    topicId: state.topicId,
    text: `<b>Cancel the approved topic?</b>\nThis cancels the entire topic and its automation job before publication. Immutable research history remains preserved.\n\nTo cancel only source entry, use Cancel on the source-entry card instead.`,
    buttons: [
      [
        button(
          "Confirm topic cancellation",
          "confirm_topic_cancel",
          state,
          secret,
        ),
      ],
      [button("Keep topic", "keep_topic", state, secret)],
    ],
  };
}

function resumeCard(
  item: ActionableResearchRecovery,
  actor: TelegramActor,
  secret: string,
) {
  return {
    topicId: item.topicId,
    text: `<b>Research needs your input</b>\n${escape(item.title)}\n\nReason: ${escape(item.reason)}\nResearch packet: v${item.packetVersion}`,
    buttons: [
      [
        {
          text: "Resume research",
          callbackData: createResumeCallback(item.job.id, actor, secret),
        },
      ],
    ],
  };
}

function classificationCard(state: ResearchRemediation, secret: string) {
  const proposal = state.proposal;
  if (!proposal) throw new Error("Source proposal is missing");
  return {
    topicId: state.topicId,
    text: `<b>Confirm source authority</b>\nPublisher: ${escape(proposal.publisher)}\nDetected ownership/group: ${escape(proposal.publisherOwner)}\nProposed authority: ${proposal.proposedAuthority}\nWhy: ${escape(proposal.reason)}\n\nThe source is not added until you confirm a classification.`,
    buttons: [
      [button("Confirm primary", "primary", state, secret)],
      [button("Treat as independent", "independent", state, secret)],
      [button("Cancel", "cancel", state, secret)],
    ],
  };
}

function inputCard(state: ResearchRemediation, secret: string) {
  return {
    topicId: state.topicId,
    text: "<b>Add a research source</b>\nPaste the official or public HTTP(S) URL for this topic. This request expires in 30 minutes.",
    buttons: [[button("Cancel", "cancel", state, secret)]],
  };
}

function button(
  text: string,
  action: Exclude<CallbackAction, "resume">,
  state: ResearchRemediation,
  secret: string,
) {
  return {
    text,
    callbackData: createCallback(action, state.shortId, state.version, secret),
  };
}

function createCallback(
  action: Exclude<CallbackAction, "resume">,
  shortId: string,
  version: number,
  secret: string,
) {
  const code = {
    add: "a",
    change: "h",
    cancel: "c",
    confirm_topic_cancel: "x",
    keep_topic: "k",
    primary: "p",
    independent: "i",
    details: "d",
    retry_later: "t",
    find_official: "f",
    paste_another: "u",
  }[action];
  const payload = `q:${code}:${shortId}:${version}`;
  return `${payload}:${sign(payload, secret)}`;
}

function createResumeCallback(
  jobId: string,
  actor: TelegramActor,
  secret: string,
) {
  const suffix = jobId.replace(/^automationjob_/, "");
  const payload = `q:r:${suffix}`;
  return `${payload}:${sign(`${payload}:${actor.chatId}:${actor.userId}`, secret)}`;
}

function parseCallback(value: string, secret: string, actor: TelegramActor) {
  const resume = /^q:r:([a-f0-9]{24}):([A-Za-z0-9_-]{10})$/.exec(value);
  if (resume) {
    const [, suffix, provided] = resume;
    const payload = `q:r:${suffix}`;
    if (
      !safeEqual(
        sign(`${payload}:${actor.chatId}:${actor.userId}`, secret),
        provided ?? "",
      )
    )
      throw new RemediationCallbackError("signature_mismatch");
    return {
      action: "resume" as const,
      jobId: `automationjob_${suffix}`,
    };
  }
  const match =
    /^q:([ahcxkpidtfu]):([a-f0-9]{12}):(\d+):([A-Za-z0-9_-]{10})$/.exec(value);
  if (!match) throw new RemediationCallbackError("malformed");
  const [, code, shortId, rawVersion, provided] = match;
  const payload = `q:${code}:${shortId}:${rawVersion}`;
  if (!safeEqual(sign(payload, secret), provided ?? ""))
    throw new RemediationCallbackError("signature_mismatch");
  const action = {
    a: "add",
    h: "change",
    c: "cancel",
    x: "confirm_topic_cancel",
    k: "keep_topic",
    p: "primary",
    i: "independent",
    d: "details",
    t: "retry_later",
    f: "find_official",
    u: "paste_another",
  }[code ?? ""];
  if (!action) throw new RemediationCallbackError("unregistered_action");
  return {
    action: action as Exclude<CallbackAction, "resume">,
    shortId: shortId as string,
    version: Number(rawVersion),
  };
}

class RemediationCallbackError extends TelegramControlError {
  constructor(readonly condition: string) {
    super("stale_callback", staleCardMessage);
  }
}

export class ResearchRemediationInspectionError extends TelegramControlError {
  constructor(
    message: string,
    readonly category: z.infer<typeof retrievalFailureSchema>["code"],
    readonly diagnosticId: string,
    readonly retryAt?: string,
  ) {
    super("invalid_url", message, 400);
  }
}

export function researchRemediationCallbackSecret(botToken: string) {
  return createHmac("sha256", botToken)
    .update("research-remediation-callback-signing-v1")
    .digest("base64url");
}

export function shouldIssueBlockedRemediationCard(
  existing: ResearchRemediation | undefined,
  now: Date,
) {
  if (!existing) return true;
  return (
    existing.version === 1 && Date.parse(existing.expiresAt) <= now.getTime()
  );
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret)
    .update(value)
    .digest("base64url")
    .slice(0, 10);
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function conciseReason(value: string) {
  return value
    .replace(/^Research blocked:\s*/i, "")
    .split(";")[0]!
    .slice(0, 1000);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
