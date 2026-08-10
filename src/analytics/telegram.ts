import { createHmac, timingSafeEqual } from "node:crypto";

import type { ProductionPublicationArtifact } from "../publication/models";
import type { TelegramActor } from "../telegram/authorization";
import { TelegramControlError } from "../telegram/errors";
import type { EditorialNotificationAdapter } from "../telegram/interfaces";
import type { TelegramUpdate } from "../telegram/models";
import type { FinalReviewControl } from "../telegram/service";
import type { AnalyticsConfig } from "./config";
import type { EditorialInsight, EditorialReport } from "./models";
import type { AnalyticsService } from "./service";

const commands = new Set([
  "/analytics",
  "/analytics_week",
  "/analytics_month",
  "/article_stats",
  "/social_stats",
  "/top_articles",
  "/editorial_insights",
  "/data_status",
  "/insight_note",
]);

export interface AnalyticsTelegramOptions {
  service: AnalyticsService;
  publications: { list(): Promise<ProductionPublicationArtifact[]> };
  adapter: EditorialNotificationAdapter;
  callbackSecret: string;
  config: AnalyticsConfig;
}

export class AnalyticsTelegramController implements FinalReviewControl {
  constructor(private readonly options: AnalyticsTelegramOptions) {}

  handlesCommand(command: string | undefined) {
    return Boolean(command && commands.has(command));
  }

  async processCommand(
    command: string,
    rest: string,
    _update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    let text: string;
    if (command === "/analytics" || command === "/data_status")
      text = await this.status();
    else if (command === "/analytics_week") text = await this.report("weekly");
    else if (command === "/analytics_month")
      text = await this.report("monthly");
    else if (command === "/article_stats") text = await this.articleStats(rest);
    else if (command === "/social_stats") text = await this.socialStats(rest);
    else if (command === "/top_articles") text = await this.topArticles();
    else if (command === "/editorial_insights")
      return this.sendInsights(actor.chatId);
    else if (command === "/insight_note") {
      const [reference = "", ...noteParts] = rest.split(/\s+/);
      if (!reference || noteParts.length === 0)
        throw new TelegramControlError(
          "invalid_command",
          "/insight_note <insight-id> <note> is required",
        );
      const insight = await this.resolveInsight(reference);
      await this.options.service.actOnInsight(
        insight.id,
        "note_added",
        noteParts.join(" "),
      );
      text = "Insight note recorded. No configuration was changed.";
    } else
      throw new TelegramControlError(
        "invalid_command",
        "Unknown analytics command",
      );
    await this.options.adapter.sendStatusMessage(
      actor.chatId,
      this.limit(text),
    );
  }

  async processCallback(update: TelegramUpdate, actor: TelegramActor) {
    const callback = update.callback_query;
    if (!callback?.data)
      throw new TelegramControlError(
        "stale_callback",
        "Invalid analytics action",
      );
    const [namespace, actionCode, shortId, versionRaw, signature] =
      callback.data.split(":");
    const unsigned = [namespace, actionCode, shortId, versionRaw].join(":");
    if (
      namespace !== "i" ||
      !actionCode ||
      !shortId ||
      !versionRaw ||
      !signature ||
      !secureEqual(signature, this.sign(unsigned))
    )
      throw new TelegramControlError(
        "stale_callback",
        "Invalid or expired insight action",
      );
    const insight = await this.resolveInsight(shortId);
    if (insight.version !== Number(versionRaw))
      throw new TelegramControlError(
        "stale_callback",
        "Insight state changed; refresh it",
      );
    const action = (
      {
        r: "reviewed",
        a: "accepted_for_consideration",
        d: "dismissed",
      } as const
    )[actionCode as "r" | "a" | "d"];
    if (!action)
      throw new TelegramControlError(
        "stale_callback",
        "Unsupported insight action",
      );
    await this.options.service.actOnInsight(insight.id, action);
    await this.options.adapter.answerCallback(
      callback.id,
      action === "accepted_for_consideration"
        ? "Accepted for consideration only"
        : `Insight ${action}`,
    );
    await this.options.adapter.sendStatusMessage(
      actor.chatId,
      "Insight decision recorded. Ranking and editorial configuration remain unchanged.",
    );
  }

  async processConversationText() {
    return false;
  }

  private async status() {
    const status = await this.options.service.status();
    const available = status.sources.filter((source) =>
      ["available", "configured"].includes(source.status),
    ).length;
    return [
      "Analytics status",
      `Sources available: ${available}/${status.sources.length}`,
      `Article metric records: ${status.articleMetricRecords}`,
      `Social metric records: ${status.socialMetricRecords}`,
      `Snapshots: ${status.snapshots}`,
      `Reports: ${status.reports}`,
      "Personal analytics: not collected",
      "Automatic strategy changes: disabled",
    ].join("\n");
  }

  private async report(type: "weekly" | "monthly") {
    const report = (await this.options.service.reports())
      .filter((value) => value.reportType === type)
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
    return report
      ? this.formatReport(report)
      : `No ${type} report is available. Generate it with the analytics CLI first.`;
  }

  private formatReport(report: EditorialReport) {
    return [
      `${report.reportType === "weekly" ? "Weekly" : "Monthly"} Content Report`,
      `Published: ${report.publicationCount}`,
      `Confirmed social posts: ${report.socialPostCount}`,
      `Best article: ${report.topPerformers[0]?.title ?? "insufficient data"}`,
      `Top insight: ${report.recommendations[0] ?? "none met the evidence threshold"}`,
      `Data quality: ${report.dataCoverage.label}`,
      "Recommendations require human review.",
    ].join("\n");
  }

  private async articleStats(topicId: string) {
    const publication = await this.publicationForTopic(topicId),
      latest = (await this.options.service.article(publication.id)).at(-1);
    return [
      `Article stats: ${publication.title}`,
      `Search impressions: ${display(latest?.searchImpressions)}`,
      `Search clicks: ${display(latest?.searchClicks)}`,
      `Search CTR: ${percent(latest?.searchCtr)}`,
      `Page views: ${display(latest?.pageViews)}`,
      `Data quality: ${latest?.dataCompleteness.label ?? "missing"}`,
    ].join("\n");
  }

  private async socialStats(topicId: string) {
    const publication = await this.publicationForTopic(topicId),
      metrics = await this.options.service.social(publication.id);
    if (!metrics.length)
      return `Social stats: ${publication.title}\nMetrics: missing (not zero)`;
    return [
      `Social stats: ${publication.title}`,
      ...metrics.map(
        (metric) =>
          `${metric.platform}: impressions ${display(metric.impressions)}, clicks ${display(metric.clicks)}, engagement ${percent(metric.engagementRate)}`,
      ),
    ].join("\n");
  }

  private async topArticles() {
    const reports = (await this.options.service.reports()).sort((a, b) =>
        b.periodEnd.localeCompare(a.periodEnd),
      ),
      top = reports[0]?.topPerformers ?? [];
    return top.length
      ? [
          "Top articles",
          ...top.map(
            (value, index) =>
              `${index + 1}. ${value.title} — ${display(value.value)}`,
          ),
        ].join("\n")
      : "Top articles\nInsufficient comparable data.";
  }

  private async sendInsights(chatId: string) {
    const insights = (await this.options.service.insights()).slice(0, 5);
    if (!insights.length)
      return void (await this.options.adapter.sendStatusMessage(
        chatId,
        "No deterministic insights are available.",
      ));
    for (const insight of insights) {
      const shortId = insight.id.slice(-12);
      await this.options.adapter.sendFinalReviewCard(chatId, {
        topicId: insight.id,
        text: this.limit(
          [
            `Editorial insight · ${shortId}`,
            insight.title,
            insight.observation,
            `Evidence: ${insight.evidence.join("; ") || "insufficient"}`,
            `Confidence: ${insight.confidence} · sample ${insight.sampleSize}`,
            `Recommendation: ${insight.recommendedAction}`,
            "Accept means consideration only. Use /insight_note <id> <note> to add a note.",
          ].join("\n"),
        ),
        buttons: [
          [
            this.button("Reviewed", "r", shortId, insight.version),
            this.button("Accept", "a", shortId, insight.version),
          ],
          [this.button("Dismiss", "d", shortId, insight.version)],
        ],
      });
    }
  }

  private button(
    text: string,
    action: string,
    shortId: string,
    version: number,
  ) {
    const unsigned = `i:${action}:${shortId}:${version}`;
    return { text, callbackData: `${unsigned}:${this.sign(unsigned)}` };
  }
  private sign(value: string) {
    return createHmac("sha256", this.options.callbackSecret)
      .update(value)
      .digest("base64url")
      .slice(0, 12);
  }
  private limit(text: string) {
    const max = Math.min(4096, this.options.config.telegramSummaryCharacters);
    return text.length <= max ? text : `${text.slice(0, max - 16)}\n…shortened`;
  }

  private async publicationForTopic(topicId: string) {
    if (!topicId)
      throw new TelegramControlError(
        "invalid_command",
        "A topic ID is required",
      );
    const matches = (await this.options.publications.list()).filter(
      (value) => value.topicId === topicId && value.status === "published",
    );
    if (matches.length !== 1)
      throw new TelegramControlError(
        "missing_topic",
        "One exact published topic match is required",
        404,
      );
    return matches[0]!;
  }
  private async resolveInsight(reference: string): Promise<EditorialInsight> {
    const matches = (await this.options.service.insights()).filter(
      (value) => value.id === reference || value.id.endsWith(reference),
    );
    if (matches.length !== 1)
      throw new TelegramControlError(
        "missing_topic",
        "One exact insight match is required",
        404,
      );
    return matches[0]!;
  }
}

const display = (value: number | null | undefined) =>
  value == null ? "missing" : String(value);
const percent = (value: number | null | undefined) =>
  value == null ? "missing" : `${(value * 100).toFixed(1)}%`;
function secureEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
