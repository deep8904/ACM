import { createHash } from "node:crypto";

import {
  log as defaultLog,
  type LogContext,
  type LogLevel,
} from "../lib/logger";
import type { StoryCluster, TopicCandidate } from "../ranking/models";
import {
  authorizeActor,
  privacySafeChatId,
  type TelegramActor,
} from "./authorization";
import { parseCallbackData } from "./callback";
import type { TelegramRuntimeConfig } from "./config";
import { TelegramControlError } from "./errors";
import {
  formatQueue,
  formatSourcePreview,
  formatTopicCard,
  helpText,
} from "./formatter";
import type {
  DnsLookup,
  EditorialNotificationAdapter,
  TopicApprovalRepository,
  TopicCatalog,
} from "./interfaces";
import {
  conversationStateSchema,
  manualTopicCandidateSchema,
  messageIndexSchema,
  processedUpdateSchema,
  topicApprovalSchema,
  topicApprovedEventSchema,
  topicQueueItemSchema,
  type ConversationState,
  type TelegramUpdate,
  type TopicQueueItem,
} from "./models";
import { systemDnsLookup, validateManualUrl } from "./safe-url";

export interface TopicApprovalServiceOptions {
  adapter: EditorialNotificationAdapter;
  repository: TopicApprovalRepository;
  catalog: TopicCatalog;
  config: TelegramRuntimeConfig;
  now?: () => Date;
  dnsLookup?: DnsLookup;
  logger?: (level: LogLevel, message: string, context: LogContext) => void;
  finalReview?: FinalReviewControl;
  publication?: FinalReviewControl;
  social?: FinalReviewControl;
  analytics?: FinalReviewControl;
  operations?: FinalReviewControl;
}

export interface FinalReviewControl {
  handlesCommand(command: string | undefined): boolean;
  processCommand(
    command: string,
    rest: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void>;
  processCallback(update: TelegramUpdate, actor: TelegramActor): Promise<void>;
  processConversationText(
    text: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<boolean>;
}

export interface UpdateResult {
  status: "processed" | "duplicate" | "unauthorized";
  action: string;
}

export class TopicApprovalService {
  private readonly now: () => Date;
  private readonly dnsLookup: DnsLookup;
  private readonly logger: (
    level: LogLevel,
    message: string,
    context: LogContext,
  ) => void;

  constructor(private readonly options: TopicApprovalServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.dnsLookup = options.dnsLookup ?? systemDnsLookup;
    this.logger = options.logger ?? defaultLog;
  }

  async processUpdate(update: TelegramUpdate): Promise<UpdateResult> {
    const actor = actorFromUpdate(update);
    const action = commandType(update);
    try {
      authorizeActor(actor, this.options.config);
    } catch {
      this.logger("warn", "Unauthorized Telegram update", {
        stage: "AWAITING_TOPIC_APPROVAL",
        telegramUpdateId: update.update_id,
        telegramChatId: privacySafeChatId(actor.chatId),
        action,
        result: "unauthorized",
      });
      await this.rejectUnauthorized(update, actor.chatId);
      return { status: "unauthorized", action };
    }

    const callbackId = update.callback_query?.id;
    const now = this.now().toISOString();
    const claimed = await this.options.repository.claimUpdate(
      update.update_id,
      callbackId,
      now,
    );
    if (!claimed) {
      if (callbackId)
        await this.options.adapter.answerCallback(
          callbackId,
          "Already processed",
        );
      return { status: "duplicate", action };
    }

    const started = performance.now();
    try {
      if (update.message) await this.processMessage(update, actor);
      else if (update.callback_query) await this.processCallback(update, actor);
      await this.options.repository.completeUpdate(
        processedUpdateSchema.parse({
          updateId: update.update_id,
          callbackQueryId: callbackId,
          status: "completed",
          processedAt: this.now().toISOString(),
          commandType: action,
        }),
      );
      this.logger("info", "Telegram update processed", {
        stage: "AWAITING_TOPIC_APPROVAL",
        telegramUpdateId: update.update_id,
        telegramChatId: privacySafeChatId(actor.chatId),
        action,
        result: "processed",
        durationMs: Math.round(performance.now() - started),
      });
      return { status: "processed", action };
    } catch (error) {
      if (
        error instanceof TelegramControlError &&
        error.code !== "persistence_failure"
      ) {
        await this.sendOperationalError(update, actor.chatId, error.message);
        await this.options.repository.completeUpdate(
          processedUpdateSchema.parse({
            updateId: update.update_id,
            callbackQueryId: callbackId,
            status: "completed",
            processedAt: this.now().toISOString(),
            commandType: action,
          }),
        );
        return { status: "processed", action };
      }
      await this.options.repository.releaseUpdate(update.update_id, callbackId);
      throw error;
    }
  }

  private async processMessage(
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    const message = update.message;
    if (!message) return;
    const text = message.text?.trim();
    if (!text)
      throw new TelegramControlError(
        "invalid_command",
        "Send /help to see supported topic commands",
      );
    if (text.startsWith("/")) {
      const [rawCommand = "", ...parts] = text.split(/\s+/);
      const command = rawCommand.split("@")[0]?.toLowerCase();
      const rest = text.slice(rawCommand.length).trim();
      await this.runCommand(command, rest, parts, update, actor);
      return;
    }
    await this.processConversationText(text, update, actor);
  }

  private async runCommand(
    command: string | undefined,
    rest: string,
    parts: string[],
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    if (this.options.operations?.handlesCommand(command)) {
      await this.options.operations.processCommand(
        command as string,
        rest,
        update,
        actor,
      );
      return;
    }
    if (this.options.analytics?.handlesCommand(command)) {
      await this.options.analytics.processCommand(
        command as string,
        rest,
        update,
        actor,
      );
      return;
    }
    if (this.options.social?.handlesCommand(command)) {
      await this.options.social.processCommand(
        command as string,
        rest,
        update,
        actor,
      );
      return;
    }
    if (this.options.publication?.handlesCommand(command)) {
      await this.options.publication.processCommand(
        command as string,
        rest,
        update,
        actor,
      );
      return;
    }
    if (this.options.finalReview?.handlesCommand(command)) {
      await this.options.finalReview.processCommand(
        command as string,
        rest,
        update,
        actor,
      );
      return;
    }
    switch (command) {
      case "/start":
        await this.start(actor.chatId);
        return;
      case "/topics":
        await this.showTopics(actor.chatId, parts[0]);
        return;
      case "/approve":
        await this.commandAction("approve", rest, update, actor);
        return;
      case "/reject":
        await this.commandAction("reject", rest, update, actor);
        return;
      case "/replace":
      case "/refresh":
        if (rest) {
          throw new TelegramControlError(
            "invalid_command",
            "/replace does not start discovery; --new-run is deferred",
          );
        }
        await this.replace(actor.chatId);
        return;
      case "/skip_cycle": {
        const pending = (await this.options.repository.listQueue()).filter(
          ({ approvalStatus }) => approvalStatus === "pending",
        );
        for (const item of pending)
          await this.applyDecision(item, "reject", update, actor);
        await this.options.adapter.sendStatusMessage(
          actor.chatId,
          `${pending.length} pending topic(s) skipped for this cycle.`,
        );
        return;
      }
      case "/add":
        await this.addOrPrompt("topic", rest, update, actor);
        return;
      case "/link":
        await this.addOrPrompt("url", rest, update, actor);
        return;
      case "/queue":
        await this.queue(actor.chatId, parts[0] === "all");
        return;
      case "/status":
        await this.status(actor.chatId, parts[0]);
        return;
      case "/cancel":
        await this.cancel(parts[0], update, actor);
        return;
      case "/help":
        await this.options.adapter.sendStatusMessage(actor.chatId, helpText);
        return;
      default:
        throw new TelegramControlError(
          "invalid_command",
          "Unknown command. Send /help for topic commands.",
        );
    }
  }

  private async start(chatId: string): Promise<void> {
    const queue = await this.options.repository.listQueue();
    const awaiting = queue.filter(
      ({ approvalStatus }) => approvalStatus === "pending",
    ).length;
    await this.options.adapter.sendStatusMessage(
      chatId,
      `<b>AI Content Machine</b>\nTopic approval control layer is ready.\n${awaiting} topic(s) await review.\n\n${helpText}`,
    );
  }

  async showTopics(
    chatId: string,
    runId?: string,
    onlyUndisplayed = false,
  ): Promise<void> {
    const run = await this.options.catalog.getRun(runId);
    const cards: TopicQueueItem[] = [];
    for (const candidate of run.candidates.slice(
      0,
      this.options.config.TELEGRAM_RECOMMENDATION_BATCH_SIZE,
    )) {
      const cluster = run.clusters.find(({ id }) => id === candidate.clusterId);
      if (!cluster) continue;
      let item = await this.options.repository.getQueueItem(candidate.id);
      if (!item) {
        item = createRankedQueueItem(
          candidate,
          cluster,
          this.now(),
          this.options.config.TELEGRAM_TOPIC_EXPIRY_HOURS,
        );
        await this.options.repository.saveQueueItem(item);
      }
      if (!onlyUndisplayed || !item.displayedAt) cards.push(item);
    }
    if (cards.length === 0) {
      await this.options.adapter.sendStatusMessage(
        chatId,
        "No eligible ranked topics are available.",
      );
      return;
    }
    await this.sendCards(chatId, cards);
  }

  private async replace(chatId: string): Promise<void> {
    const run = await this.options.catalog.getRun();
    const existing = await this.options.repository.listQueue();
    const excluded = new Set(existing.map(({ candidateId }) => candidateId));
    const candidates = run.candidates
      .filter(({ id }) => !excluded.has(id))
      .slice(0, this.options.config.TELEGRAM_RECOMMENDATION_BATCH_SIZE);
    const items: TopicQueueItem[] = [];
    for (const candidate of candidates) {
      const cluster = run.clusters.find(({ id }) => id === candidate.clusterId);
      if (!cluster) continue;
      const item = createRankedQueueItem(
        candidate,
        cluster,
        this.now(),
        this.options.config.TELEGRAM_TOPIC_EXPIRY_HOURS,
      );
      await this.options.repository.saveQueueItem(item);
      items.push(item);
    }
    if (items.length === 0)
      await this.options.adapter.sendStatusMessage(
        chatId,
        "No more eligible ranked topics are available. Discovery was not started.",
      );
    else await this.sendCards(chatId, items);
  }

  private async sendCards(
    chatId: string,
    items: readonly TopicQueueItem[],
  ): Promise<void> {
    const cards = items.map((item, index) =>
      formatTopicCard(item, index + 1, this.options.config.callbackSecret),
    );
    const messages = await this.options.adapter.sendTopicRecommendations(
      chatId,
      cards,
    );
    for (const [index, item] of items.entries()) {
      const message = messages[index];
      if (!message) continue;
      const updated = topicQueueItemSchema.parse({
        ...item,
        displayedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      });
      await this.options.repository.saveQueueItem(updated, item.version);
      await this.options.repository.saveMessageIndex(
        messageIndexSchema.parse({
          shortId: item.shortId,
          topicId: item.topicId,
          chatId,
          telegramMessageId: message.messageId,
          version: item.version,
          updatedAt: this.now().toISOString(),
        }),
      );
    }
  }

  private async commandAction(
    action: "approve" | "reject",
    references: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    if (!references)
      throw new TelegramControlError(
        "invalid_command",
        `Usage: /${action} 1,3 or /${action} topic_id`,
      );
    const parts = references.split(/[\s,]+/).filter(Boolean);
    const queue = (await this.options.repository.listQueue()).filter(
      ({ approvalStatus }) => approvalStatus === "pending",
    );
    const selected = parts.map((reference) =>
      resolveReference(reference, queue),
    );
    for (const item of selected)
      await this.applyDecision(item, action, update, actor);
    await this.options.adapter.sendStatusMessage(
      actor.chatId,
      `${selected.length} topic(s) ${action === "approve" ? "approved" : "rejected"}.`,
    );
  }

  private async processCallback(
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    const callback = update.callback_query;
    if (!callback?.data)
      throw new TelegramControlError(
        "stale_callback",
        "This action is invalid or expired",
      );
    if (callback.data.startsWith("i:")) {
      if (!this.options.analytics)
        throw new TelegramControlError(
          "stale_callback",
          "Analytics review is not configured",
        );
      await this.options.analytics.processCallback(update, actor);
      return;
    }
    if (callback.data.startsWith("a:")) {
      if (!this.options.finalReview)
        throw new TelegramControlError(
          "stale_callback",
          "Final article approval is not configured",
        );
      await this.options.finalReview.processCallback(update, actor);
      return;
    }
    if (callback.data.startsWith("s:")) {
      if (!this.options.social)
        throw new TelegramControlError(
          "stale_callback",
          "Social approval is not configured",
        );
      await this.options.social.processCallback(update, actor);
      return;
    }
    if (callback.data.startsWith("d:")) {
      if (!this.options.social)
        throw new TelegramControlError(
          "stale_callback",
          "Social distribution is not configured",
        );
      await this.options.social.processCallback(update, actor);
      return;
    }
    const parsed = parseCallbackData(
      callback.data,
      this.options.config.callbackSecret,
    );
    const item = await this.options.repository.getQueueItemByShortId(
      parsed.shortId,
    );
    if (!item)
      throw new TelegramControlError(
        "missing_topic",
        "This topic is no longer available",
        404,
      );
    if (item.version !== parsed.version)
      throw new TelegramControlError(
        "stale_callback",
        "Topic state changed. Run /topics to refresh.",
        409,
      );
    if (parsed.action === "a")
      await this.applyDecision(item, "approve", update, actor);
    else if (parsed.action === "r") {
      await this.applyDecision(item, "reject", update, actor);
      await this.setConversation(
        "awaiting_rejection_reason",
        actor,
        item.topicId,
      );
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        "Topic rejected. Optionally send a reason, or /cancel to skip.",
      );
    } else if (parsed.action === "s") {
      const run =
        item.origin === "ranked"
          ? await this.options.catalog.getRun(item.runId)
          : undefined;
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        formatSourcePreview(
          item,
          run?.sourceItems ?? [],
          this.options.config.TELEGRAM_MAX_SOURCE_PREVIEW,
        ),
      );
    } else if (parsed.action === "g") {
      this.assertNotCancelled(item);
      await this.setConversation("awaiting_angle", actor, item.topicId);
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        "Send the revised article angle, or /cancel.",
      );
    } else if (parsed.action === "n") {
      this.assertNotCancelled(item);
      await this.setConversation("awaiting_note", actor, item.topicId);
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        "Send the editorial note, or /cancel.",
      );
    }
    await this.options.adapter.answerCallback(callback.id, "Done");
  }

  private async applyDecision(
    item: TopicQueueItem,
    action: "approve" | "reject",
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    this.assertPending(item);
    if (item.expiresAt && Date.parse(item.expiresAt) <= this.now().getTime())
      throw new TelegramControlError(
        "expired_topic",
        "This topic expired. Refresh recommendations.",
        409,
      );
    if (
      item.origin === "ranked" &&
      (await this.options.catalog.latestRunId()) !== item.runId
    )
      throw new TelegramControlError(
        "stale_callback",
        "This ranking run was superseded. Run /topics to refresh.",
        409,
      );
    const status = action === "approve" ? "approved" : "rejected";
    const updated = topicQueueItemSchema.parse({
      ...item,
      approvalStatus: status,
      researchReadiness:
        action === "approve" ? "ready_for_research" : "rejected",
      triggerState:
        action === "approve" ? "topic_approved_event_created" : "not_triggered",
      updatedAt: this.now().toISOString(),
      version: item.version + 1,
    });
    const existingApproval = await this.options.repository.getByTopicId(
      item.topicId,
    );
    const approval = topicApprovalSchema.parse({
      id:
        existingApproval?.id ??
        `approval_${hash(`${item.topicId}\0${actor.chatId}`).slice(0, 24)}`,
      topicId: item.topicId,
      candidateId: item.candidateId,
      runId: item.runId,
      chatId: actor.chatId,
      userId: actor.userId,
      action,
      status,
      editorialNotes: item.editorialNotes,
      requestedAngle: item.requestedAngle,
      createdAt: existingApproval?.createdAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      telegramUpdateId: update.update_id,
      telegramMessageId:
        update.callback_query?.message?.message_id ??
        update.message?.message_id,
      callbackQueryId: update.callback_query?.id,
      version: (existingApproval?.version ?? 0) + 1,
    });
    const approvedEvent =
      action === "approve"
        ? topicApprovedEventSchema.parse({
            id: `event_${hash(item.topicId).slice(0, 24)}`,
            topicId: item.topicId,
            candidateId: item.candidateId,
            runId: item.runId,
            approvedAt: this.now().toISOString(),
            approvedBy: {
              telegramUserId: actor.userId,
              telegramChatId: actor.chatId,
            },
            approvedAngle:
              updated.requestedAngle ||
              updated.candidateSnapshot.candidate.recommendedAngle,
            editorialNotes: updated.editorialNotes,
            sourceItemIds: updated.candidateSnapshot.candidate.sourceItemIds,
            origin: updated.origin,
            status: "ready",
            consumed: false,
            version: 1,
          })
        : undefined;
    if (this.options.repository.saveDecision) {
      await this.options.repository.saveDecision(
        updated,
        approval,
        approvedEvent,
        item.version,
        existingApproval?.version,
      );
    } else {
      await this.options.repository.saveQueueItem(updated, item.version);
      await this.options.repository.saveApproval(
        approval,
        existingApproval?.version,
      );
      if (approvedEvent)
        await this.options.repository.saveApprovedEvent(approvedEvent);
    }
    await this.refreshMessage(updated);
  }

  private async addOrPrompt(
    type: "topic" | "url",
    value: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    if (!value) {
      await this.setConversation(
        type === "topic" ? "awaiting_custom_topic" : "awaiting_url",
        actor,
      );
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        type === "topic"
          ? "Send the custom topic title, or /cancel."
          : "Send the HTTP or HTTPS URL, or /cancel.",
      );
      return;
    }
    await this.createManual(type, value, update, actor);
  }

  private async createManual(
    type: "topic" | "url",
    value: string,
    _update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    const normalizedUrl =
      type === "url"
        ? await validateManualUrl(value, this.dnsLookup)
        : undefined;
    if (normalizedUrl) {
      const duplicate = (await this.options.repository.listQueue()).some(
        (item) =>
          item.candidateSnapshot.kind === "manual_url" &&
          item.candidateSnapshot.candidate.submittedUrl === normalizedUrl,
      );
      if (duplicate)
        throw new TelegramControlError(
          "queue_conflict",
          "That URL already exists in the topic queue",
          409,
        );
    }
    const now = this.now();
    const identity = hash(
      `${type}\0${normalizedUrl ?? value}\0${actor.userId}\0${now.toISOString()}`,
    ).slice(0, 24);
    const candidate = manualTopicCandidateSchema.parse({
      id: `topic_manual_${identity}`,
      candidateId: `manual_${identity}`,
      runId: `manual_${now.toISOString().slice(0, 10).replaceAll("-", "")}`,
      title:
        type === "url"
          ? `Manual URL: ${new URL(normalizedUrl as string).hostname}`
          : value,
      submittedUrl: normalizedUrl,
      summary:
        type === "url"
          ? "User-submitted URL. No page was fetched and no evidence has been collected."
          : "User-submitted topic. Evidence has not been collected.",
      recommendedAngle: "",
      score: null,
      selectionReasons: ["manually submitted"],
      evidenceStrength: "unresearched",
      sourceItemIds: [],
      primarySourceItemIds: [],
      submittedAt: now.toISOString(),
      submittedByUserId: actor.userId,
      submittedInChatId: actor.chatId,
    });
    const item = topicQueueItemSchema.parse({
      id: `queue_${hash(candidate.id).slice(0, 24)}`,
      shortId: hash(candidate.id).slice(0, 12),
      topicId: candidate.id,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      candidateSnapshot: {
        kind: type === "url" ? "manual_url" : "manual_topic",
        candidate,
      },
      approvalStatus: "pending",
      researchReadiness: "blocked_pending_approval",
      editorialNotes: [],
      requestedAngle: "",
      origin: type === "url" ? "manual_url" : "manual_topic",
      triggerState: "not_triggered",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
    });
    await this.options.repository.saveQueueItem(item);
    await this.sendCards(actor.chatId, [item]);
    await this.options.repository.clearConversation(actor.chatId, actor.userId);
  }

  private async processConversationText(
    text: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    if (
      this.options.analytics &&
      (await this.options.analytics.processConversationText(
        text,
        update,
        actor,
      ))
    )
      return;
    if (
      this.options.social &&
      (await this.options.social.processConversationText(text, update, actor))
    )
      return;
    if (
      this.options.finalReview &&
      (await this.options.finalReview.processConversationText(
        text,
        update,
        actor,
      ))
    )
      return;
    const state = await this.options.repository.getConversation(
      actor.chatId,
      actor.userId,
    );
    if (!state)
      throw new TelegramControlError(
        "invalid_state_transition",
        "No input is expected. Send /help for commands.",
      );
    if (Date.parse(state.expiresAt) <= this.now().getTime()) {
      await this.options.repository.clearConversation(
        actor.chatId,
        actor.userId,
      );
      throw new TelegramControlError(
        "invalid_state_transition",
        "That input request expired. Start the command again.",
      );
    }
    if (state.state === "awaiting_custom_topic")
      return this.createManual("topic", text, update, actor);
    if (state.state === "awaiting_url")
      return this.createManual("url", text, update, actor);
    const item = state.topicId
      ? await this.options.repository.getQueueItem(state.topicId)
      : undefined;
    if (!item)
      throw new TelegramControlError(
        "missing_topic",
        "The related topic no longer exists",
        404,
      );
    if (state.state === "awaiting_angle")
      await this.updateEditorial(
        item,
        { requestedAngle: text },
        "change_angle",
        update,
        actor,
      );
    else if (state.state === "awaiting_note")
      await this.updateEditorial(
        item,
        { editorialNotes: [...item.editorialNotes, text] },
        "add_note",
        update,
        actor,
      );
    else if (state.state === "awaiting_rejection_reason")
      await this.updateEditorial(
        item,
        {
          editorialNotes: [...item.editorialNotes, `Rejection reason: ${text}`],
        },
        "reject",
        update,
        actor,
      );
    await this.options.repository.clearConversation(actor.chatId, actor.userId);
  }

  private async updateEditorial(
    item: TopicQueueItem,
    changes: Partial<Pick<TopicQueueItem, "requestedAngle" | "editorialNotes">>,
    action: "change_angle" | "add_note" | "reject",
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    this.assertNotCancelled(item);
    const updated = topicQueueItemSchema.parse({
      ...item,
      ...changes,
      updatedAt: this.now().toISOString(),
      version: item.version + 1,
    });
    await this.options.repository.saveQueueItem(updated, item.version);
    const approval = await this.options.repository.getByTopicId(item.topicId);
    if (approval)
      await this.options.repository.saveApproval(
        topicApprovalSchema.parse({
          ...approval,
          action,
          editorialNotes: updated.editorialNotes,
          requestedAngle: updated.requestedAngle,
          updatedAt: this.now().toISOString(),
          telegramUpdateId: update.update_id,
          version: approval.version + 1,
        }),
        approval.version,
      );
    if (updated.approvalStatus === "approved") {
      const event = await this.options.repository.getApprovedEventByTopicId(
        updated.topicId,
      );
      if (event) {
        await this.options.repository.updateApprovedEvent(
          topicApprovedEventSchema.parse({
            ...event,
            approvedAngle:
              updated.requestedAngle ||
              updated.candidateSnapshot.candidate.recommendedAngle,
            editorialNotes: updated.editorialNotes,
            version: event.version + 1,
          }),
          event.version,
        );
      }
    }
    await this.refreshMessage(updated);
    await this.options.adapter.sendStatusMessage(
      actor.chatId,
      "Editorial instruction saved.",
    );
  }

  private async queue(chatId: string, includeClosed: boolean): Promise<void> {
    await this.options.adapter.sendStatusMessage(
      chatId,
      formatQueue(await this.options.repository.listQueue(), includeClosed),
    );
  }

  private async status(chatId: string, reference?: string): Promise<void> {
    if (!reference)
      throw new TelegramControlError(
        "invalid_command",
        "Usage: /status topic_id",
      );
    const item = resolveReference(
      reference,
      await this.options.repository.listQueue(),
    );
    await this.options.adapter.sendStatusMessage(
      chatId,
      `Topic ${item.shortId}\nStatus: ${item.approvalStatus}\nResearch readiness: ${item.researchReadiness}\nHandoff: ${item.triggerState}\nFinal article approval: still required in a future milestone.`,
    );
  }

  private async cancel(
    reference: string | undefined,
    update: TelegramUpdate,
    actor: TelegramActor,
  ): Promise<void> {
    if (!reference) {
      await this.options.repository.clearConversation(
        actor.chatId,
        actor.userId,
      );
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        "Pending input cancelled.",
      );
      return;
    }
    const item = resolveReference(
      reference,
      await this.options.repository.listQueue(),
    );
    if (
      item.approvalStatus !== "approved" ||
      item.triggerState !== "topic_approved_event_created"
    )
      throw new TelegramControlError(
        "invalid_state_transition",
        "Only an approved, unpublished topic can be cancelled",
      );
    const updated = topicQueueItemSchema.parse({
      ...item,
      approvalStatus: "cancelled",
      researchReadiness: "cancelled",
      triggerState: "cancelled",
      updatedAt: this.now().toISOString(),
      version: item.version + 1,
    });
    await this.options.repository.saveQueueItem(updated, item.version);
    const approval = await this.options.repository.getByTopicId(item.topicId);
    if (approval)
      await this.options.repository.saveApproval(
        topicApprovalSchema.parse({
          ...approval,
          action: "cancel",
          status: "cancelled",
          updatedAt: this.now().toISOString(),
          telegramUpdateId: update.update_id,
          version: approval.version + 1,
        }),
        approval.version,
      );
    const event = await this.options.repository.getApprovedEventByTopicId(
      item.topicId,
    );
    if (event) {
      await this.options.repository.updateApprovedEvent(
        topicApprovedEventSchema.parse({
          ...event,
          status: "cancelled",
          version: event.version + 1,
        }),
        event.version,
      );
    }
    await this.refreshMessage(updated);
    await this.options.adapter.sendStatusMessage(
      actor.chatId,
      "Approved topic cancelled before research processing.",
    );
  }

  private async setConversation(
    state: ConversationState["state"],
    actor: TelegramActor,
    topicId?: string,
  ): Promise<void> {
    const now = this.now();
    await this.options.repository.saveConversation(
      conversationStateSchema.parse({
        id: `conversation_${hash(`${actor.chatId}\0${actor.userId}`).slice(0, 24)}`,
        chatId: actor.chatId,
        userId: actor.userId,
        state,
        topicId,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() +
            this.options.config.TELEGRAM_CONVERSATION_TTL_MINUTES * 60_000,
        ).toISOString(),
        version: 1,
      }),
    );
  }

  private async refreshMessage(item: TopicQueueItem): Promise<void> {
    const index = await this.options.repository.getMessageIndex(item.shortId);
    if (!index) return;
    await this.options.adapter.updateTopicMessage(
      index.chatId,
      index.telegramMessageId,
      formatTopicCard(item, 1, this.options.config.callbackSecret),
    );
    await this.options.repository.saveMessageIndex(
      messageIndexSchema.parse({
        ...index,
        version: item.version,
        updatedAt: this.now().toISOString(),
      }),
    );
  }

  private assertPending(item: TopicQueueItem): void {
    if (item.approvalStatus !== "pending")
      throw new TelegramControlError(
        "invalid_state_transition",
        `Topic is already ${item.approvalStatus}. Refresh the topic list.`,
        409,
      );
  }

  private assertNotCancelled(item: TopicQueueItem): void {
    if (item.approvalStatus === "cancelled")
      throw new TelegramControlError(
        "invalid_state_transition",
        "This topic was cancelled",
        409,
      );
  }

  private async rejectUnauthorized(
    update: TelegramUpdate,
    chatId: string,
  ): Promise<void> {
    if (update.callback_query)
      await this.options.adapter.answerCallback(
        update.callback_query.id,
        "Not authorized",
        true,
      );
    else
      await this.options.adapter.sendStatusMessage(chatId, "Not authorized.");
  }

  private async sendOperationalError(
    update: TelegramUpdate,
    chatId: string,
    message: string,
  ): Promise<void> {
    if (update.callback_query)
      await this.options.adapter.answerCallback(
        update.callback_query.id,
        message.slice(0, 180),
        true,
      );
    else await this.options.adapter.sendStatusMessage(chatId, message);
  }
}

function createRankedQueueItem(
  candidate: TopicCandidate,
  cluster: StoryCluster,
  now: Date,
  expiryHours: number,
): TopicQueueItem {
  return topicQueueItemSchema.parse({
    id: `queue_${hash(candidate.id).slice(0, 24)}`,
    shortId: hash(candidate.id).slice(0, 12),
    topicId: candidate.id,
    candidateId: candidate.id,
    runId: candidate.runId,
    candidateSnapshot: { kind: "ranked", candidate, cluster },
    approvalStatus: "pending",
    researchReadiness: "blocked_pending_approval",
    editorialNotes: [],
    requestedAngle: candidate.recommendedAngle,
    origin: "ranked",
    triggerState: "not_triggered",
    expiresAt: new Date(now.getTime() + expiryHours * 3_600_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
  });
}

function resolveReference(
  reference: string,
  queue: readonly TopicQueueItem[],
): TopicQueueItem {
  const index = /^\d+$/.test(reference) ? Number(reference) - 1 : -1;
  const rankedOrder = [...queue].sort((left, right) => {
    const leftScore =
      left.candidateSnapshot.kind === "ranked"
        ? left.candidateSnapshot.candidate.score
        : -1;
    const rightScore =
      right.candidateSnapshot.kind === "ranked"
        ? right.candidateSnapshot.candidate.score
        : -1;
    return (
      rightScore - leftScore ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  });
  const item =
    index >= 0
      ? rankedOrder[index]
      : queue.find(({ topicId, candidateId, shortId }) =>
          [topicId, candidateId, shortId].includes(reference),
        );
  if (!item)
    throw new TelegramControlError(
      "missing_topic",
      `Topic reference ${reference} was not found`,
      404,
    );
  return item;
}

function actorFromUpdate(update: TelegramUpdate): TelegramActor {
  const message = update.message ?? update.callback_query?.message;
  const user = update.message?.from ?? update.callback_query?.from;
  if (!message || !user)
    throw new TelegramControlError(
      "unauthorized",
      "Telegram actor information is missing",
      403,
    );
  return {
    chatId: String(message.chat.id),
    userId: String(user.id),
    chatType: message.chat.type,
  };
}

function commandType(update: TelegramUpdate): string {
  if (update.callback_query) return "callback";
  const first = update.message?.text?.trim().split(/\s+/)[0];
  return first?.startsWith("/")
    ? (first.split("@")[0]?.toLowerCase() ?? "command")
    : "text";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
