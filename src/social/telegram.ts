import type { ProductionPublicationArtifactRepository } from "../publication/interfaces";
import type { TelegramActor } from "../telegram/authorization";
import { TelegramControlError } from "../telegram/errors";
import { escapeTelegramHtml } from "../telegram/formatter";
import type {
  EditorialNotificationAdapter,
  TopicCard,
} from "../telegram/interfaces";
import type { TelegramUpdate } from "../telegram/models";
import type { FinalReviewControl } from "../telegram/service";
import {
  createSocialCallback,
  parseSocialCallback,
  type SocialCallbackAction,
} from "./callback";
import type { SocialConfig } from "./config";
import type { SocialConversationRepository } from "./interfaces";
import type { SocialService } from "./service";
import type { SocialDistributionService } from "./distribution";
import {
  createDistributionCallback,
  parseDistributionCallback,
} from "./distribution-callback";
import {
  socialConversationSchema,
  type SocialPackage,
  type SocialPlatform,
  type SocialDistributionPlan,
} from "./models";
export class SocialTelegramController implements FinalReviewControl {
  constructor(
    private o: {
      service: SocialService;
      publications: ProductionPublicationArtifactRepository;
      adapter: EditorialNotificationAdapter;
      callbackSecret: string;
      config: SocialConfig;
      conversations: SocialConversationRepository;
      distribution?: SocialDistributionService;
      clock?: () => Date;
    },
  ) {}
  handlesCommand(c: string | undefined) {
    return [
      "/social",
      "/social_package",
      "/approve_social",
      "/schedule_social",
      "/changes_social",
      "/reject_social",
      "/mark_posted",
      "/distribute",
      "/social_status",
    ].includes(c ?? "");
  }
  async processCommand(
    command: string,
    rest: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    const parts = rest.split(/\s+/).filter(Boolean);
    if (["/distribute", "/social", "/social_status"].includes(command)) {
      if (!this.o.distribution)
        throw new Error("Social distribution plans are unavailable");
      const publicationId = await this.publicationId(parts[0]);
      const plan = await this.o.distribution.offer(publicationId);
      await this.sendDistributionCard(actor.chatId, plan);
      return;
    }
    if (command === "/mark_posted") {
      await this.o.service.markPosted(
        await this.publicationId(parts[0]),
        this.platform(parts[1]),
        parts[2] ?? "",
      );
      await this.o.adapter.sendStatusMessage(
        actor.chatId,
        "Manual posted record saved. No engagement data was collected.",
      );
      return;
    }
    const publicationId = await this.publicationId(parts[0]);
    if (command === "/social_package") {
      const pkg = await this.o.service.getPackageRecord(publicationId);
      if (!pkg) {
        await this.o.adapter.sendStatusMessage(
          actor.chatId,
          "No social package exists for this publication.",
        );
        return;
      }
      await this.sendCards(actor.chatId, pkg);
      return;
    }
    const platform = this.platform(parts[1]);
    const pkg = await this.o.service.getPackageRecord(publicationId);
    if (!pkg) throw new Error("Social package not found");
    const action =
      command === "/approve_social"
        ? "approve"
        : command === "/schedule_social"
          ? "schedule"
          : command === "/changes_social"
            ? "request_changes"
            : "reject";
    await this.o.service.approve(publicationId, platform, pkg.version, action, {
      publishAt: action === "schedule" ? parts.slice(2).join(" ") : undefined,
      notes:
        action === "approve" || action === "reject"
          ? [parts.slice(2).join(" ")].filter(Boolean)
          : [],
      changes:
        action === "request_changes"
          ? [parts.slice(2).join(" ") || "Changes requested in Telegram"]
          : [],
      telegramUpdateId: update.update_id,
    });
    await this.o.adapter.sendStatusMessage(
      actor.chatId,
      `Social ${platform} state updated. Nothing was posted.`,
    );
  }
  async processCallback(update: TelegramUpdate, actor: TelegramActor) {
    const query = update.callback_query;
    if (!query) throw new Error("Social callback query missing");
    if ((query.data ?? "").startsWith("d:")) {
      await this.processDistributionCallback(update, actor);
      return;
    }
    const parsed = parseSocialCallback(query.data ?? "", this.o.callbackSecret),
      found = await this.resolveItem(parsed.itemShortId);
    if (!found || found.pkg.version !== parsed.version)
      throw new Error("Stale or unknown social callback");
    const callbackAge =
      (this.o.clock?.() ?? new Date()).valueOf() -
      new Date(found.pkg.updatedAt).valueOf();
    if (
      !Number.isFinite(callbackAge) ||
      callbackAge > this.o.config.approvalCallbackExpiryMinutes * 60_000
    )
      throw new Error("Expired social callback");
    if (parsed.action === "v") {
      await this.o.adapter.sendStatusMessage(
        actor.chatId,
        this.preview(found.item),
      );
      await this.o.adapter.answerCallback(query.id, "Preview opened");
      return;
    }
    if (parsed.action === "q") {
      const quality = await this.o.service.quality(
        found.pkg.publicationId,
        found.pkg.version,
      );
      const itemQuality = quality.find(
        (value) => value.platformItemId === found.item.id,
      );
      await this.o.adapter.sendStatusMessage(
        actor.chatId,
        itemQuality
          ? `Quality: ${itemQuality.status}; claim alignment: ${itemQuality.claimAlignment}; blockers: ${itemQuality.blockingIssues.length}; warnings: ${itemQuality.warnings.length}.`
          : "Quality report is unavailable.",
      );
      await this.o.adapter.answerCallback(query.id, "Quality opened");
      return;
    }
    if (parsed.action === "n" || parsed.action === "b") {
      await this.o.adapter.answerCallback(
        query.id,
        "All platform cards are already visible in this review batch",
      );
      return;
    }
    if (["c", "r", "t", "p"].includes(parsed.action)) {
      const conversationalAction = parsed.action as "c" | "r" | "t" | "p";
      const state = {
        c: "awaiting_social_change_request",
        r: "awaiting_social_rejection_reason",
        t: "awaiting_social_schedule_time",
        p: "awaiting_social_post_url",
      }[conversationalAction] as
        | "awaiting_social_change_request"
        | "awaiting_social_rejection_reason"
        | "awaiting_social_schedule_time"
        | "awaiting_social_post_url";
      const now = this.o.clock?.() ?? new Date();
      await this.o.conversations.save(
        socialConversationSchema.parse({
          chatId: actor.chatId,
          userId: actor.userId,
          publicationId: found.pkg.publicationId,
          packageVersion: found.pkg.version,
          platformItemId: found.item.id,
          platform: found.item.platform,
          state,
          createdAt: now.toISOString(),
          expiresAt: new Date(
            now.valueOf() + this.o.config.conversationExpiryMinutes * 60_000,
          ).toISOString(),
        }),
      );
      await this.o.adapter.sendStatusMessage(
        actor.chatId,
        state === "awaiting_social_schedule_time"
          ? "Send an exact future date/time in America/Phoenix or with an explicit offset."
          : state === "awaiting_social_post_url"
            ? "Send the public post URL after manually posting."
            : "Send the bounded reason or requested change.",
      );
      await this.o.adapter.answerCallback(query.id, "Waiting for input");
      return;
    }
    const action: {
      [K in SocialCallbackAction]?:
        "approve" | "request_changes" | "hold" | "reject" | "schedule";
    } = {
      a: "approve",
      c: "request_changes",
      h: "hold",
      r: "reject",
      t: "schedule",
    };
    const mapped = action[parsed.action];
    if (!mapped) throw new Error("Unsupported social callback action");
    await this.o.service.approve(
      found.pkg.publicationId,
      found.item.platform,
      found.pkg.version,
      mapped,
      {
        itemId: found.item.id,
        telegramUpdateId: update.update_id,
        callbackQueryId: query.id,
        changes:
          mapped === "request_changes"
            ? ["Changes requested from signed callback"]
            : [],
      },
    );
    await this.o.adapter.answerCallback(query.id, "Social state updated");
  }
  private async processDistributionCallback(
    update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    const query = update.callback_query;
    if (!query?.data || !this.o.distribution)
      throw new Error("Distribution callback is unavailable");
    const parsed = parseDistributionCallback(query.data, this.o.callbackSecret);
    const plan = await this.o.distribution.getPlanByShortId(parsed.planShortId);
    if (!plan) throw new Error("Unknown social distribution plan");
    const callbackIssuedAt = query.message?.date
      ? query.message.date * 1000
      : new Date(plan.updatedAt).valueOf();
    const callbackAge =
      (this.o.clock?.() ?? new Date()).valueOf() - callbackIssuedAt;
    if (
      !Number.isFinite(callbackAge) ||
      callbackAge > this.o.config.approvalCallbackExpiryMinutes * 60_000
    )
      throw new Error("Expired social distribution callback");
    const context = {
      telegramUpdateId: update.update_id,
      callbackQueryId: query.id,
      actorUserId: actor.userId,
    };
    let next: SocialDistributionPlan;
    if (["linkedin", "x", "instagram", "medium"].includes(parsed.action))
      next = await this.o.distribution.toggle(
        plan.id,
        parsed.action as SocialPlatform,
        parsed.revision,
        context,
      );
    else if (parsed.action === "prepare") {
      const status = await this.o.distribution.prepare(
        plan.id,
        parsed.revision,
        context,
      );
      next = status.plan;
    } else if (parsed.action === "confirm") {
      const status = await this.o.distribution.confirm(plan.id, context);
      next = status.plan;
    } else if (parsed.action === "review") {
      const status = await this.o.distribution.status(plan.id);
      await this.o.adapter.sendStatusMessage(
        actor.chatId,
        this.distributionDetails(status.plan),
      );
      await this.o.adapter.answerCallback(query.id, "Details opened");
      return;
    } else {
      next = await this.o.distribution.cancel(
        plan.id,
        parsed.action === "skip",
        context,
      );
    }
    const card = this.distributionCard(next);
    if (query.message)
      await this.o.adapter.updateFinalReviewCard(
        actor.chatId,
        query.message.message_id,
        card,
      );
    else await this.o.adapter.sendFinalReviewCard(actor.chatId, card);
    await this.o.adapter.answerCallback(
      query.id,
      next.status === "selecting"
        ? "Selection updated"
        : next.status === "manual_ready"
          ? "Manual export ready"
          : "Distribution state updated",
    );
  }
  async processConversationText(
    text: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    const state = await this.o.conversations.get(actor.chatId, actor.userId);
    if (!state) return false;
    const now = this.o.clock?.() ?? new Date();
    if (Date.parse(state.expiresAt) <= now.valueOf()) {
      await this.o.conversations.clear(actor.chatId, actor.userId);
      throw new Error("Social input request expired");
    }
    if (state.state === "awaiting_social_post_url")
      await this.o.service.markPosted(
        state.publicationId,
        state.platform,
        text,
        { itemId: state.platformItemId, version: state.packageVersion },
      );
    else
      await this.o.service.approve(
        state.publicationId,
        state.platform,
        state.packageVersion,
        state.state === "awaiting_social_schedule_time"
          ? "schedule"
          : state.state === "awaiting_social_rejection_reason"
            ? "reject"
            : "request_changes",
        {
          itemId: state.platformItemId,
          publishAt:
            state.state === "awaiting_social_schedule_time" ? text : undefined,
          notes:
            state.state === "awaiting_social_rejection_reason" ? [text] : [],
          changes:
            state.state === "awaiting_social_change_request" ? [text] : [],
          telegramUpdateId: update.update_id,
        },
      );
    await this.o.conversations.clear(actor.chatId, actor.userId);
    await this.o.adapter.sendStatusMessage(
      actor.chatId,
      "Social state saved. Nothing was posted automatically.",
    );
    return true;
  }
  async sendDistributionOffer(chatId: string, publicationId: string) {
    if (!this.o.distribution)
      throw new Error("Social distribution plans are unavailable");
    const plan = await this.o.distribution.offer(publicationId);
    return this.sendDistributionCard(chatId, plan);
  }
  private async sendCards(chatId: string, pkg: SocialPackage) {
    for (const item of pkg.items) {
      const short = item.id.slice(-12),
        card: TopicCard = {
          topicId: pkg.topicId,
          text: `<b>${escapeTelegramHtml(pkg.articleTitle)}</b>\n${item.platform} · ${item.contentType}\nPackage v${pkg.version} · ${item.characterCount} characters\nWarnings: ${item.warnings.length}\n${escapeTelegramHtml(pkg.canonicalUrl)}`,
          buttons: [
            [
              {
                text: "Approve",
                callbackData: createSocialCallback(
                  "a",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
              {
                text: "Schedule",
                callbackData: createSocialCallback(
                  "t",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
              {
                text: "Changes",
                callbackData: createSocialCallback(
                  "c",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
            ],
            [
              {
                text: "Hold",
                callbackData: createSocialCallback(
                  "h",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
              {
                text: "Reject",
                callbackData: createSocialCallback(
                  "r",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
              {
                text: "View text",
                callbackData: createSocialCallback(
                  "v",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
            ],
            [
              {
                text: "View quality",
                callbackData: createSocialCallback(
                  "q",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
              {
                text: "Previous",
                callbackData: createSocialCallback(
                  "b",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
              {
                text: "Next",
                callbackData: createSocialCallback(
                  "n",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
            ],
            [
              {
                text: "Mark posted manually",
                callbackData: createSocialCallback(
                  "p",
                  short,
                  pkg.version,
                  this.o.callbackSecret,
                ),
              },
            ],
          ],
        };
      await this.o.adapter.sendFinalReviewCard(chatId, card);
    }
  }
  private sendDistributionCard(chatId: string, plan: SocialDistributionPlan) {
    return this.o.adapter.sendFinalReviewCard(
      chatId,
      this.distributionCard(plan),
    );
  }
  private distributionCard(plan: SocialDistributionPlan): TopicCard {
    const short = plan.id.slice(-12);
    const selected = new Set(plan.selectedPlatforms);
    const capability = (platform: SocialPlatform) =>
      this.o.distribution?.capabilities(platform).canAutoPost
        ? "Auto-post available"
        : "Manual export required";
    const platformLine = (["linkedin", "x", "instagram", "medium"] as const)
      .map((platform) => `${platformName(platform)}: ${capability(platform)}`)
      .join("\n");
    const stateLines = plan.platformStates.length
      ? `\n\n${plan.platformStates
          .map(
            (state) =>
              `${platformName(state.platform)} ${stateIcon(state.state)} ${state.state.replaceAll("_", " ")}${state.assetIds.length ? ` · ${state.assetIds.length} image${state.assetIds.length === 1 ? "" : "s"}` : ""}${state.warnings.length ? ` · ${state.warnings.length} warning${state.warnings.length === 1 ? "" : "s"}` : ""}`,
          )
          .join("\n")}`
      : "";
    const selectionButtons = [
      (["linkedin", "x"] as const).map((platform) => ({
        text: `${selected.has(platform) ? "✓" : "□"} ${platformName(platform)}`,
        callbackData: createDistributionCallback(
          platform,
          short,
          plan.selectionRevision,
          this.o.callbackSecret,
        ),
      })),
      (["instagram", "medium"] as const).map((platform) => ({
        text: `${selected.has(platform) ? "✓" : "□"} ${platformName(platform)}`,
        callbackData: createDistributionCallback(
          platform,
          short,
          plan.selectionRevision,
          this.o.callbackSecret,
        ),
      })),
    ];
    const actionButtons =
      plan.status === "selecting"
        ? [
            [
              {
                text: "Prepare selected",
                callbackData: createDistributionCallback(
                  "prepare",
                  short,
                  plan.selectionRevision,
                  this.o.callbackSecret,
                ),
              },
            ],
            [
              {
                text: "Skip social",
                callbackData: createDistributionCallback(
                  "skip",
                  short,
                  plan.selectionRevision,
                  this.o.callbackSecret,
                ),
              },
            ],
          ]
        : plan.status === "ready_for_confirmation"
          ? [
              [
                {
                  text: "Confirm selected",
                  callbackData: createDistributionCallback(
                    "confirm",
                    short,
                    plan.selectionRevision,
                    this.o.callbackSecret,
                  ),
                },
                {
                  text: "Review details",
                  callbackData: createDistributionCallback(
                    "review",
                    short,
                    plan.selectionRevision,
                    this.o.callbackSecret,
                  ),
                },
              ],
              [
                {
                  text: "Cancel",
                  callbackData: createDistributionCallback(
                    "cancel",
                    short,
                    plan.selectionRevision,
                    this.o.callbackSecret,
                  ),
                },
              ],
            ]
          : plan.status === "blocked"
            ? [
                [
                  {
                    text: "Review blocking item",
                    callbackData: createDistributionCallback(
                      "review",
                      short,
                      plan.selectionRevision,
                      this.o.callbackSecret,
                    ),
                  },
                  {
                    text: "Cancel",
                    callbackData: createDistributionCallback(
                      "cancel",
                      short,
                      plan.selectionRevision,
                      this.o.callbackSecret,
                    ),
                  },
                ],
              ]
            : [];
    const bundleLocation = this.o.distribution?.exportBundleLocation(plan);
    const readyLine =
      plan.status === "manual_ready" && bundleLocation
        ? `\n\n<b>Ready to post manually</b>\nExport bundle: <code>${escapeTelegramHtml(bundleLocation)}</code>`
        : "";
    return {
      topicId: plan.publicationId,
      text: `<b>${plan.status === "selecting" ? "Distribute this article" : "Social distribution"}</b>\n${escapeTelegramHtml(plan.articleTitle)}\n\n${platformLine}${stateLines}\n\nStatus: ${escapeTelegramHtml(plan.status.replaceAll("_", " "))}${readyLine}`,
      buttons: [
        ...(plan.status === "selecting" ? selectionButtons : []),
        ...actionButtons,
      ],
    };
  }
  private distributionDetails(plan: SocialDistributionPlan) {
    return `<b>Distribution details</b>\n${escapeTelegramHtml(plan.articleTitle)}\n${plan.platformStates
      .map(
        (state) =>
          `${platformName(state.platform)} · ${state.state.replaceAll("_", " ")} · ${state.itemIds.length} copy item(s) · ${state.assetIds.length} image(s)${state.warnings.length ? `\n${state.warnings.map((warning) => `• ${escapeTelegramHtml(warning)}`).join("\n")}` : ""}`,
      )
      .join("\n")}`;
  }
  private preview(item: SocialPackage["items"][number]) {
    const text = [
      item.title,
      item.text,
      ...(item.thread ?? []),
      ...(item.slides ?? []).flatMap((x) => [x.headline, x.body]),
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      escapeTelegramHtml(
        text.slice(0, this.o.config.telegramPreviewCharacters),
      ) +
      (text.length > this.o.config.telegramPreviewCharacters
        ? "\n…preview shortened"
        : "")
    );
  }
  private async publicationId(value?: string) {
    if (!value)
      throw new TelegramControlError(
        "invalid_command",
        "A topic or verified production publication ID is required.",
      );
    if (value.startsWith("publication_")) {
      const record = await this.o.publications.getById(value);
      if (!record)
        throw new TelegramControlError(
          "invalid_command",
          "Verified production publication not found.",
        );
      return record.id;
    }
    if (value.startsWith("republish_"))
      throw new TelegramControlError(
        "invalid_command",
        "A republish ID is not a verified production publication ID.",
      );
    const record = (await this.o.publications.list())
      .filter((item) => item.topicId === value)
      .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
    if (!record)
      throw new TelegramControlError(
        "invalid_command",
        "Verified production publication not found.",
      );
    return record.id;
  }
  private platform(value?: string) {
    return (
      ((["linkedin", "x", "instagram", "medium"].includes(value ?? "")
        ? value
        : undefined) as SocialPlatform | undefined) ??
      (() => {
        throw new Error("A valid platform is required");
      })()
    );
  }
  private async resolveItem(short: string) {
    for (const publication of await this.o.publications.list()) {
      const pkg = await this.o.service.getPackageRecord(publication.id);
      const item = pkg?.items.find((x) => x.id.endsWith(short));
      if (pkg && item) return { pkg, item };
    }
    return undefined;
  }
}

function platformName(platform: SocialPlatform) {
  return {
    linkedin: "LinkedIn",
    x: "X",
    instagram: "Instagram",
    medium: "Medium",
  }[platform];
}

function stateIcon(
  state: SocialDistributionPlan["platformStates"][number]["state"],
) {
  return ["blocked", "failed"].includes(state)
    ? "⚠"
    : state === "selected"
      ? "○"
      : "✓";
}
