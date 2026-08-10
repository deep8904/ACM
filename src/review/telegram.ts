import type { TelegramActor } from "../telegram/authorization";
import { TelegramControlError } from "../telegram/errors";
import type {
  EditorialNotificationAdapter,
  TopicCard,
} from "../telegram/interfaces";
import type { TelegramUpdate } from "../telegram/models";
import type { FinalReviewControl } from "../telegram/service";
import { sha256 } from "../writing/task";
import { createFinalCallbackData, parseFinalCallbackData } from "./callback";
import type { ReviewConfig } from "./config";
import type {
  DraftPreviewRepository,
  EditorialReviewRepository,
  FinalApprovalRepository,
  FinalConversationRepository,
} from "./interfaces";
import type {
  ArticleDraftRepository,
  DraftQualityRepository,
} from "../writing/interfaces";
import {
  finalConversationStateSchema,
  type FinalApprovalRecord,
} from "./models";
import type { RevisionService } from "./revision";
import type { FinalApprovalService } from "./final-approval";

const commands = new Set([
  "/articles",
  "/drafts",
  "/review",
  "/article",
  "/approve_article",
  "/schedule_article",
  "/cancel_article",
  "/changes",
  "/hold_article",
  "/reject_article",
]);

export class FinalReviewTelegramController implements FinalReviewControl {
  constructor(
    private deps: {
      service: FinalApprovalService;
      revision: RevisionService;
      reviews: EditorialReviewRepository;
      drafts: ArticleDraftRepository;
      quality: DraftQualityRepository;
      previews: DraftPreviewRepository;
      approvals: FinalApprovalRepository;
      conversations: FinalConversationRepository;
      adapter: EditorialNotificationAdapter;
      callbackSecret: string;
      config: ReviewConfig;
      previewUrl?: (
        preview: NonNullable<
          Awaited<ReturnType<DraftPreviewRepository["get"]>>
        >,
      ) => string;
      clock?: () => Date;
    },
  ) {}
  private now() {
    return (this.deps.clock ?? (() => new Date()))();
  }
  handlesCommand(command: string | undefined) {
    return Boolean(command && commands.has(command));
  }

  async notify(topicId: string, chatId: string, userId: string) {
    const resolved = await this.resolve(topicId);
    const approval = await this.deps.service.ensurePending(
      topicId,
      resolved.draftVersion,
      resolved.reviewVersion,
      {
        telegramChatId: chatId,
        telegramUserId: userId,
        telegramUpdateId: Math.floor(this.now().getTime() / 1000),
      },
    );
    const sent = await this.deps.adapter.sendFinalReviewCard(
      chatId,
      await this.card(approval),
    );
    if (!approval.telegramMessageId) {
      const displayed = {
        ...approval,
        telegramMessageId: sent.messageId,
        updatedAt: this.now().toISOString(),
        version: approval.version + 1,
      };
      await this.deps.approvals.save(displayed);
      await this.deps.adapter.updateFinalReviewCard(
        chatId,
        sent.messageId,
        await this.card(displayed),
      );
      return displayed;
    }
    return approval;
  }

  async processCommand(
    command: string,
    rest: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    const parts = rest.split(/\s+/).filter(Boolean);
    if (command === "/articles" || command === "/drafts") {
      const values = await this.deps.approvals.list();
      const text = values.length
        ? values
            .map(
              (x) =>
                `${escape(x.topicId)} · draft v${x.draftVersion} · ${x.status}`,
            )
            .join("\n")
        : "No final article approvals are pending.";
      await this.deps.adapter.sendStatusMessage(actor.chatId, text);
      return;
    }
    if (command === "/cancel_article") {
      const topicId = required(parts[0], "Usage: /cancel_article <topic-id>");
      await this.deps.service.cancel(topicId, meta(update, actor));
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        "Final article approval cancelled.",
      );
      return;
    }
    const topicId = required(parts[0], `Usage: ${command} <topic-id>`);
    const resolved = await this.resolve(topicId, parts[1], parts[2]);
    const { draftVersion, reviewVersion } = resolved;
    if (command === "/article" || command === "/review") {
      const approval = await this.deps.service.ensurePending(
        topicId,
        draftVersion,
        reviewVersion,
        meta(update, actor),
      );
      const sent = await this.deps.adapter.sendFinalReviewCard(
        actor.chatId,
        await this.card(approval),
      );
      if (!approval.telegramMessageId) {
        const displayed = {
          ...approval,
          telegramMessageId: sent.messageId,
          updatedAt: this.now().toISOString(),
          version: approval.version + 1,
        };
        await this.deps.approvals.save(displayed);
        await this.deps.adapter.updateFinalReviewCard(
          actor.chatId,
          sent.messageId,
          await this.card(displayed),
        );
      }
      return;
    }
    if (command === "/approve_article") {
      await this.deps.service.act(
        topicId,
        draftVersion,
        reviewVersion,
        "approve_publish",
        meta(update, actor),
      );
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        "Article approved. The publication event is ready and unconsumed.",
      );
      return;
    }
    if (command === "/schedule_article") {
      const at = required(
        parts.slice(resolved.usedExplicitVersions ? 3 : 1).join(" "),
        "Include an ISO or Phoenix local schedule time",
      );
      await this.deps.service.act(
        topicId,
        draftVersion,
        reviewVersion,
        "approve_schedule",
        meta(update, actor),
        { scheduledFor: at },
      );
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        "Article approval scheduled. Nothing was published.",
      );
      return;
    }
    const action =
      command === "/hold_article"
        ? "hold"
        : command === "/reject_article"
          ? "reject"
          : command === "/changes"
            ? "request_changes"
            : undefined;
    if (action) {
      const note = parts.slice(resolved.usedExplicitVersions ? 3 : 1).join(" ");
      if (!note && (action === "request_changes" || action === "reject")) {
        const approval =
          (await this.deps.approvals.get(topicId)) ??
          (await this.deps.service.ensurePending(
            topicId,
            draftVersion,
            reviewVersion,
            meta(update, actor),
          ));
        await this.conversation(
          action === "request_changes"
            ? "awaiting_final_change_request"
            : "awaiting_article_rejection_reason",
          approval,
          actor,
        );
        return;
      }
      await this.deps.service.act(
        topicId,
        draftVersion,
        reviewVersion,
        action,
        meta(update, actor),
        { notes: note ? [note] : [] },
      );
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        `Final article status: ${action}. Nothing was published.`,
      );
    }
  }

  async processCallback(update: TelegramUpdate, actor: TelegramActor) {
    const query = update.callback_query;
    if (!query?.data)
      throw new TelegramControlError(
        "stale_callback",
        "Invalid final article action",
      );
    let parsed;
    try {
      parsed = parseFinalCallbackData(query.data, this.deps.callbackSecret);
    } catch {
      throw new TelegramControlError(
        "stale_callback",
        "Invalid or outdated final article action",
        400,
      );
    }
    const approval = await this.deps.approvals.getByShortId(parsed.shortId);
    if (!approval || approval.version !== parsed.version)
      throw new TelegramControlError(
        "stale_callback",
        "Article state changed. Run /article again.",
        409,
      );
    if (
      Date.parse(approval.updatedAt) +
        this.deps.config.finalApprovalCallbackExpiryMinutes * 60_000 <=
      this.now().getTime()
    )
      throw new TelegramControlError(
        "stale_callback",
        "This final article action expired.",
        409,
      );
    const actorMeta = meta(update, actor);
    if (parsed.action === "p")
      await this.deps.service.act(
        approval.topicId,
        approval.draftVersion,
        approval.reviewVersion,
        "approve_publish",
        actorMeta,
      );
    else if (parsed.action === "h")
      await this.deps.service.act(
        approval.topicId,
        approval.draftVersion,
        approval.reviewVersion,
        "hold",
        actorMeta,
      );
    else if (parsed.action === "x")
      await this.deps.service.cancel(approval.topicId, actorMeta);
    else if (parsed.action === "s")
      await this.conversation("awaiting_schedule_time", approval, actor);
    else if (parsed.action === "c")
      await this.conversation("awaiting_final_change_request", approval, actor);
    else if (parsed.action === "r")
      await this.conversation(
        "awaiting_article_rejection_reason",
        approval,
        actor,
      );
    else if (["i", "q", "v"].includes(parsed.action)) {
      const [review, quality, draft] = await Promise.all([
        this.deps.reviews.get(
          approval.topicId,
          approval.draftVersion,
          approval.reviewVersion,
        ),
        this.deps.quality.get(approval.topicId, approval.draftVersion),
        this.deps.drafts.get(approval.topicId, approval.draftVersion),
      ]);
      const text =
        parsed.action === "i"
          ? review?.issues.length
            ? review.issues
                .map((x) => `${x.severity}: ${escape(x.title)}`)
                .join("\n")
            : "No editorial issues."
          : parsed.action === "q"
            ? `Quality: ${quality?.status ?? "missing"}; citation coverage ${quality?.citationCoverage.score ?? 0}%.`
            : `Sources: ${draft?.sourceIds.length ?? 0}. Source details remain in private local artifacts.`;
      await this.deps.adapter.sendStatusMessage(actor.chatId, text);
    } else if (["t", "u"].includes(parsed.action)) {
      await this.conversation("awaiting_final_change_request", approval, actor);
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        parsed.action === "t"
          ? "Describe the replacement title request."
          : "Describe how the introduction should be shortened.",
      );
    }
    await this.deps.adapter.answerCallback(
      query.id,
      ["s", "c", "r"].includes(parsed.action)
        ? "Send the requested details"
        : "Done",
    );
  }

  async processConversationText(
    text: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    const state = await this.deps.conversations.get(actor.chatId, actor.userId);
    if (!state) return false;
    if (Date.parse(state.expiresAt) <= this.now().getTime()) {
      await this.deps.conversations.clear(actor.chatId, actor.userId);
      throw new TelegramControlError(
        "invalid_state_transition",
        "That final approval prompt expired.",
      );
    }
    const actorMeta = meta(update, actor);
    if (state.state === "awaiting_schedule_time")
      await this.deps.service.act(
        state.topicId,
        state.draftVersion,
        state.reviewVersion,
        "approve_schedule",
        actorMeta,
        { scheduledFor: text },
      );
    else if (state.state === "awaiting_article_rejection_reason")
      await this.deps.service.act(
        state.topicId,
        state.draftVersion,
        state.reviewVersion,
        "reject",
        actorMeta,
        { notes: [text] },
      );
    else if (state.state === "awaiting_final_change_request") {
      await this.deps.service.act(
        state.topicId,
        state.draftVersion,
        state.reviewVersion,
        "request_changes",
        actorMeta,
        { notes: [text] },
      );
      const review = await this.deps.reviews.get(
        state.topicId,
        state.draftVersion,
        state.reviewVersion,
      );
      const issueIds =
        review?.issues.filter((x) => x.status === "open").map((x) => x.id) ??
        [];
      await this.deps.revision.prepare(
        state.topicId,
        state.draftVersion,
        issueIds,
        { requestedChange: text, origin: "telegram" },
      );
    }
    await this.deps.conversations.clear(actor.chatId, actor.userId);
    await this.deps.adapter.sendStatusMessage(
      actor.chatId,
      "Final article decision recorded. Nothing was published.",
    );
    return true;
  }

  private async conversation(
    state:
      | "awaiting_schedule_time"
      | "awaiting_final_change_request"
      | "awaiting_article_rejection_reason",
    approval: FinalApprovalRecord,
    actor: TelegramActor,
  ) {
    const now = this.now();
    await this.deps.conversations.save(
      finalConversationStateSchema.parse({
        id: `finalconversation_${sha256(`${actor.chatId}:${actor.userId}:${approval.topicId}:${state}`).slice(0, 24)}`,
        chatId: actor.chatId,
        userId: actor.userId,
        state,
        topicId: approval.topicId,
        draftVersion: approval.draftVersion,
        reviewVersion: approval.reviewVersion,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() +
            this.deps.config.conversationStateExpiryMinutes * 60_000,
        ).toISOString(),
        version: 1,
      }),
    );
    await this.deps.adapter.sendStatusMessage(
      actor.chatId,
      state === "awaiting_schedule_time"
        ? "Send YYYY-MM-DDTHH:mm (America/Phoenix) or an ISO time with offset."
        : "Send the reason or requested change.",
    );
  }

  private async resolve(
    topicId: string,
    draftRaw?: string,
    reviewRaw?: string,
  ) {
    if (draftRaw && reviewRaw)
      return {
        draftVersion: number(draftRaw),
        reviewVersion: number(reviewRaw),
        usedExplicitVersions: true,
      };
    const approval = await this.deps.approvals.get(topicId);
    if (approval)
      return {
        draftVersion: approval.draftVersion,
        reviewVersion: approval.reviewVersion,
        usedExplicitVersions: false,
      };
    const draft = await this.deps.drafts.get(topicId);
    if (!draft)
      throw new TelegramControlError(
        "missing_topic",
        "No validated article draft exists",
        404,
      );
    const review = await this.deps.reviews.get(topicId, draft.version);
    if (!review)
      throw new TelegramControlError(
        "invalid_state_transition",
        "The current draft has no editorial review",
        409,
      );
    return {
      draftVersion: draft.version,
      reviewVersion: review.version,
      usedExplicitVersions: false,
    };
  }

  private async card(value: FinalApprovalRecord): Promise<TopicCard> {
    const [draft, review, quality, preview] = await Promise.all([
      this.deps.drafts.get(value.topicId, value.draftVersion),
      this.deps.reviews.get(
        value.topicId,
        value.draftVersion,
        value.reviewVersion,
      ),
      this.deps.quality.get(value.topicId, value.draftVersion),
      this.deps.previews.get(value.topicId, value.draftVersion),
    ]);
    if (!draft || !review || !quality)
      throw new Error("Final review card inputs are unavailable");
    const blockers = review.issues.filter(
      (x) => x.status === "open" && x.blocking,
    ).length;
    const warnings = review.issues.filter(
      (x) => x.status === "open" && ["info", "warning"].includes(x.severity),
    ).length;
    return {
      topicId: value.topicId,
      text: `<b>Final article approval</b>\n${escape(draft.title)}\nDraft v${draft.version} · ${draft.articleType}\n${draft.wordCount} words · ${draft.readingTimeMinutes} min\nResearch v${draft.researchPacketVersion} · Review: ${review.decision}\nCitations: ${quality.citationCoverage.score}% · Sources: ${draft.sourceIds.length}\nRisk: ${review.riskSummary.overall} · Blockers: ${blockers} · Warnings: ${warnings}\nSuggested state: ${value.status}\nPreview: ${escape(preview ? (this.deps.previewUrl?.(preview) ?? preview.path) : "preview unavailable")}\nSocial later: ${blockers === 0 ? "eligible after publication" : "not eligible"}\nFinal approval starts protected automatic publication.`,
      buttons: buttons(value, this.deps.callbackSecret),
    };
  }
}

function buttons(
  value: FinalApprovalRecord,
  secret: string,
): TopicCard["buttons"] {
  return [
    [
      {
        text: "Approve",
        callbackData: createFinalCallbackData(
          "p",
          value.shortId,
          value.version,
          secret,
        ),
      },
      {
        text: "Schedule",
        callbackData: createFinalCallbackData(
          "s",
          value.shortId,
          value.version,
          secret,
        ),
      },
    ],
    [
      {
        text: "Request changes",
        callbackData: createFinalCallbackData(
          "c",
          value.shortId,
          value.version,
          secret,
        ),
      },
      {
        text: "Hold",
        callbackData: createFinalCallbackData(
          "h",
          value.shortId,
          value.version,
          secret,
        ),
      },
    ],
    [
      {
        text: "Reject",
        callbackData: createFinalCallbackData(
          "r",
          value.shortId,
          value.version,
          secret,
        ),
      },
      {
        text: "Cancel",
        callbackData: createFinalCallbackData(
          "x",
          value.shortId,
          value.version,
          secret,
        ),
      },
    ],
    [
      {
        text: "Issues",
        callbackData: createFinalCallbackData(
          "i",
          value.shortId,
          value.version,
          secret,
        ),
      },
      {
        text: "Sources",
        callbackData: createFinalCallbackData(
          "v",
          value.shortId,
          value.version,
          secret,
        ),
      },
      {
        text: "Quality",
        callbackData: createFinalCallbackData(
          "q",
          value.shortId,
          value.version,
          secret,
        ),
      },
    ],
    [
      {
        text: "Regenerate title",
        callbackData: createFinalCallbackData(
          "t",
          value.shortId,
          value.version,
          secret,
        ),
      },
      {
        text: "Shorten introduction",
        callbackData: createFinalCallbackData(
          "u",
          value.shortId,
          value.version,
          secret,
        ),
      },
    ],
  ];
}
function meta(update: TelegramUpdate, actor: TelegramActor) {
  return {
    telegramChatId: actor.chatId,
    telegramUserId: actor.userId,
    telegramUpdateId: update.update_id,
    telegramMessageId:
      update.callback_query?.message?.message_id ?? update.message?.message_id,
    callbackQueryId: update.callback_query?.id,
  };
}
function number(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new TelegramControlError(
      "invalid_command",
      "Draft and review versions must be positive integers",
    );
  return parsed;
}
function required(value: string | undefined, message: string) {
  if (!value) throw new TelegramControlError("invalid_command", message);
  return value;
}
function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
