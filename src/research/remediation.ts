import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { DatabaseClient } from "../database/client";
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
import { loadResearchHandoff } from "../orchestration/research-handoff";

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
  save(
    value: ResearchRemediation,
    expectedVersion?: number,
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
      set packet_version=${item.packetVersion},state=${item.state},reason=${item.reason},
        version=${item.version},expires_at=${item.expiresAt},payload=${this.sql.json(toJsonValue(item))},
        updated_at=${item.updatedAt}
      where id=${item.id} and version=${expectedVersion}
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
    const id = `remediationevent_${hash(`${input.remediationId}:${input.action}:${input.dedupeKey}`).slice(0, 24)}`;
    await this.sql`
      insert into content_machine.research_remediation_events
        (id,remediation_id,topic_id,job_id,action,diagnostic_id,payload)
      values (${id},${input.remediationId},${input.topicId},${input.jobId},${input.action},${input.diagnosticId ?? null},${this.sql.json(toJsonValue(input.details ?? {}))})
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
    const packet = await this.assertRecoverable(job);
    const now = this.now();
    const identity = hash(`${job.id}:${actor.chatId}:${actor.userId}`);
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
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (this.deps.ttlMinutes ?? 30) * 60_000,
      ).toISOString(),
      version: 1,
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
    await this.deps.remediation.save(value);
    await this.deps.remediation.audit({
      remediationId: value.id,
      topicId: value.topicId,
      jobId: value.jobId,
      action: "opened",
      dedupeKey: job.id,
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
        throw new TelegramControlError(
          "invalid_url",
          `${error.message}. Try another public URL. Reference: ${diagnosticId}`,
          400,
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

  private async assertRecoverable(job: AutomationJob) {
    if (job.type !== "research" || job.status !== "blocked")
      throw new Error("Automation job is not a blocked research job");
    const event = await loadResearchHandoff(job, this.deps.events);
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
      throw new Error("Research block is not eligible for source remediation");
    const queue = await this.deps.events.queue(event.topicId);
    if (
      !queue ||
      queue.approvalStatus !== "approved" ||
      !["ready_for_research", "awaiting_source"].includes(
        queue.researchReadiness,
      ) ||
      !(await this.deps.events.isConsumed(event.id))
    )
      throw new Error("Research lineage is not active and consumed");
    return packet;
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
type CallbackAction =
  "add" | "change" | "cancel" | "primary" | "independent" | "details";

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

  async processCallback(update: TelegramUpdate, actor: TelegramActor) {
    const query = update.callback_query;
    if (!query?.data)
      throw new TelegramControlError(
        "stale_callback",
        "Missing recovery action",
      );
    const parsed = parseCallback(query.data, this.deps.callbackSecret);
    const state = await this.deps.repository.getByShortId(parsed.shortId);
    if (
      !state ||
      state.chatId !== actor.chatId ||
      state.userId !== actor.userId
    )
      throw new TelegramControlError(
        "stale_callback",
        "This research recovery action is not available to this operator.",
        403,
      );
    if (state.version !== parsed.version)
      throw new TelegramControlError(
        "stale_callback",
        "Research recovery state changed. Use /status to refresh.",
        409,
      );
    if (Date.parse(state.expiresAt) <= this.now().getTime())
      throw new TelegramControlError(
        "stale_callback",
        "This research recovery action expired.",
        409,
      );
    if (parsed.action === "add") {
      await this.promptForUrl(state);
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
    } else {
      await this.deps.cancelTopic(state.topicId, update, actor);
      await this.deps.service.cancelJob(state, query.id);
      await this.transition(state, "cancelled");
      if (parsed.action === "change") {
        await this.deps.adapter.sendStatusMessage(
          actor.chatId,
          "Blocked topic cancelled with its history preserved. Current topic options follow.",
        );
        await this.deps.refreshTopics(actor.chatId);
      }
    }
    await this.deps.adapter.answerCallback(query.id, "Done");
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
    const proposal = await this.deps.service.inspect(state, text);
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
    });
    await this.deps.adapter.sendFinalReviewCard(
      next.chatId,
      inputCard(next, this.deps.callbackSecret),
    );
  }

  private async transition(
    state: ResearchRemediation,
    nextState: ResearchRemediation["state"],
    changes: Partial<
      Pick<ResearchRemediation, "proposal" | "packetVersion">
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
}

function blockedCard(state: ResearchRemediation, secret: string) {
  return {
    topicId: state.topicId,
    text: `<b>Research blocked</b>\n${escape(state.reason)}\n\nNo article was drafted or published.`,
    buttons: [
      [button("Add primary source", "add", state, secret)],
      [
        button("Change topic", "change", state, secret),
        button("Cancel", "cancel", state, secret),
      ],
      [button("Details", "details", state, secret)],
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
  action: CallbackAction,
  state: ResearchRemediation,
  secret: string,
) {
  return {
    text,
    callbackData: createCallback(action, state.shortId, state.version, secret),
  };
}

function createCallback(
  action: CallbackAction,
  shortId: string,
  version: number,
  secret: string,
) {
  const code = {
    add: "a",
    change: "h",
    cancel: "c",
    primary: "p",
    independent: "i",
    details: "d",
  }[action];
  const payload = `q:${code}:${shortId}:${version}`;
  return `${payload}:${sign(payload, secret)}`;
}

function parseCallback(value: string, secret: string) {
  const match = /^q:([ahcpid]):([a-f0-9]{12}):(\d+):([A-Za-z0-9_-]{10})$/.exec(
    value,
  );
  if (!match)
    throw new TelegramControlError(
      "stale_callback",
      "Invalid research recovery action",
    );
  const [, code, shortId, rawVersion, provided] = match;
  const payload = `q:${code}:${shortId}:${rawVersion}`;
  if (!safeEqual(sign(payload, secret), provided ?? ""))
    throw new TelegramControlError(
      "stale_callback",
      "Invalid research recovery action",
    );
  const action = {
    a: "add",
    h: "change",
    c: "cancel",
    p: "primary",
    i: "independent",
    d: "details",
  }[code ?? ""];
  if (!action)
    throw new TelegramControlError(
      "stale_callback",
      "Invalid research recovery action",
    );
  return {
    action: action as CallbackAction,
    shortId: shortId as string,
    version: Number(rawVersion),
  };
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
