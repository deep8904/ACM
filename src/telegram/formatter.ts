import type { SourceItem } from "../discovery/models/source-item";
import type { CallbackAction } from "./callback";
import { createCallbackData } from "./callback";
import type { TopicCard } from "./interfaces";
import type { TopicQueueItem } from "./models";

const telegramMessageLimit = 4096;

export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatTopicCard(
  item: TopicQueueItem,
  rank: number,
  callbackSecret: string,
): TopicCard {
  const snapshot = item.candidateSnapshot;
  const title = snapshot.candidate.title;
  const summary =
    snapshot.candidate.summary ||
    "No summary yet; this topic still requires research.";
  const angle =
    item.requestedAngle ||
    snapshot.candidate.recommendedAngle ||
    "Angle to be determined during research.";
  let detail: string[];
  if (snapshot.kind === "ranked") {
    const candidate = snapshot.candidate;
    const cluster = snapshot.cluster;
    detail = [
      `<b>Topic ${rank} · Score ${candidate.score.toFixed(2)}</b>`,
      `<b>${escapeTelegramHtml(title)}</b>`,
      escapeTelegramHtml(summary),
      `<b>Why now:</b> ${escapeTelegramHtml(candidate.selectionReasons.join("; ") || "Deterministic ranking threshold passed")}`,
      `<b>Recommended angle:</b> ${escapeTelegramHtml(angle)}`,
      `<b>Evidence:</b> ${candidate.evidenceStrength} · ${candidate.primarySourceItemIds.length} primary · ${cluster.independentSourceCount} independent`,
      `<b>Shelf life:</b> ${candidate.estimatedShelfLife}`,
      `<b>Risks:</b> ${escapeTelegramHtml(candidate.risks.join("; ") || "none identified")}`,
      `<b>Selection:</b> ${escapeTelegramHtml(candidate.selectionReasons.join("; ") || "eligible deterministic score")}`,
      `<b>Status:</b> ${item.approvalStatus}`,
    ];
  } else {
    detail = [
      `<b>Manual topic · Unscored</b>`,
      `<b>${escapeTelegramHtml(title)}</b>`,
      escapeTelegramHtml(summary),
      `<b>Evidence:</b> unresearched`,
      `<b>Recommended angle:</b> ${escapeTelegramHtml(angle)}`,
      `<b>Status:</b> ${item.approvalStatus}`,
      snapshot.kind === "manual_url" && snapshot.candidate.submittedUrl
        ? `<b>URL:</b> ${escapeTelegramHtml(snapshot.candidate.submittedUrl)}`
        : "",
    ].filter(Boolean);
  }
  if (item.editorialNotes.length > 0) {
    detail.push(
      `<b>Editorial notes:</b> ${escapeTelegramHtml(item.editorialNotes.join(" · "))}`,
    );
  }
  return {
    topicId: item.topicId,
    text: truncate(detail.join("\n\n"), telegramMessageLimit),
    buttons:
      item.approvalStatus === "pending"
        ? [
            [
              button("Approve", "a"),
              button("Skip", "r"),
              button("Sources", "s"),
            ],
            [button("Change angle", "g"), button("Add note", "n")],
          ]
        : item.approvalStatus === "approved"
          ? [
              [
                button("Sources", "s"),
                button("Change angle", "g"),
                button("Add note", "n"),
              ],
            ]
          : [[button("Sources", "s")]],
  };

  function button(text: string, action: CallbackAction) {
    return {
      text,
      callbackData: createCallbackData(
        action,
        item.shortId,
        item.version,
        callbackSecret,
      ),
    };
  }
}

export function formatSourcePreview(
  item: TopicQueueItem,
  sourceItems: readonly SourceItem[],
  maximum: number,
): string {
  if (item.candidateSnapshot.kind !== "ranked")
    return "This manual topic has no source preview yet. Research has not started.";
  const ids = new Set(item.candidateSnapshot.candidate.sourceItemIds);
  const sources = sourceItems.filter(({ id }) => ids.has(id)).slice(0, maximum);
  if (sources.length === 0)
    return "Source metadata is unavailable for this run. No article pages were fetched.";
  return truncate(
    [
      `<b>Sources for ${escapeTelegramHtml(item.candidateSnapshot.candidate.title)}</b>`,
      ...sources.map((source, index) =>
        [
          `${index + 1}. <b>${escapeTelegramHtml(source.sourceName)}</b>${source.authority === "primary" ? " · PRIMARY" : ""}`,
          `Authority: ${source.authority}`,
          `Published: ${source.publishedAt ?? "unknown"}`,
          escapeTelegramHtml(source.canonicalUrl),
        ].join("\n"),
      ),
    ].join("\n\n"),
    telegramMessageLimit,
  );
}

export function formatQueue(
  items: readonly TopicQueueItem[],
  includeClosed = false,
): string {
  const visible = items.filter(
    (item) =>
      includeClosed || !["rejected", "cancelled"].includes(item.approvalStatus),
  );
  if (visible.length === 0) return "The topic queue is empty.";
  return truncate(
    [
      "<b>Topic queue</b>",
      ...visible.map(
        (item) =>
          `${escapeTelegramHtml(item.shortId)} · ${item.approvalStatus} · ${item.researchReadiness} · ${escapeTelegramHtml(item.candidateSnapshot.candidate.title)}`,
      ),
    ].join("\n"),
    telegramMessageLimit,
  );
}

export const helpText = `<b>AI Content Machine — topic approval</b>
/topics [runId] — ranked recommendations
/approve 1,3 or topic_id — approve topics
/reject 1,3 or topic_id — reject topics
/replace — show unused ranked topics
/refresh — show unused ranked topics
/skip_cycle — skip every pending topic in this cycle
/add &lt;topic&gt; — submit a manual topic
/link &lt;https://…&gt; — submit a URL without fetching it
/queue [all] — inspect topic state
/status &lt;topic_id&gt; — inspect one topic
/cancel [topic_id] — cancel pending input or an approved unpublished topic
/jobs — queued, running, failed, and blocked automation jobs
/retry &lt;automationjob_id&gt; — safely retry a failed or blocked job
/cancel_job &lt;automationjob_id&gt; — safely cancel queued work
/add_source &lt;topic_id&gt; — recover blocked research with a public source URL
/system_status — database, webhook, scheduler, worker, GitHub, Vercel, and AI readiness
/drafts — list final article approval state
/review &lt;topic_id&gt; — open the final review card
/article &lt;topic_id&gt; — open the final review card
/approve_article &lt;topic_id&gt; — approve the exact reviewed draft
/schedule_article &lt;topic_id&gt; &lt;date-time&gt; — request a future Phoenix/offset time
/changes &lt;topic_id&gt; — request a targeted revision
/hold_article &lt;topic_id&gt; — hold final approval
/reject_article &lt;topic_id&gt; — reject final approval
/publications — list publication state
/publication &lt;topic_id&gt; — inspect a publication
/retry_deployment &lt;topic_id&gt; — retry eligible deployment verification
/verify_publication &lt;topic_id&gt; — open manual verification state
/distribute &lt;publication_id&gt; — choose platforms in one distribution card
/social &lt;topic_id&gt; — open the consolidated distribution card
/social_status &lt;publication_id&gt; — reopen distribution status
/social_package &lt;publication_id&gt; — review an exact social package
/approve_social &lt;publication_id&gt; &lt;platform&gt; — approve manual export
/schedule_social &lt;publication_id&gt; &lt;platform&gt; &lt;date-time&gt; — record a manual schedule
/changes_social &lt;publication_id&gt; &lt;platform&gt; — request bounded changes
/reject_social &lt;publication_id&gt; &lt;platform&gt; — reject platform output
/mark_posted &lt;publication_id&gt; &lt;platform&gt; &lt;public-url&gt; — confirm a manual post
/analytics — aggregate analytics status
/analytics_week — latest weekly editorial report
/analytics_month — latest monthly editorial report
/article_stats &lt;topic_id&gt; — aggregate article metrics
/social_stats &lt;topic_id&gt; — aggregate social metrics
/top_articles — latest comparable performers
/editorial_insights — review deterministic insights
/data_status — provider and missing-data status
/insight_note &lt;insight_id&gt; &lt;note&gt; — add an editorial note
/help — command examples

Topic approval automatically starts research. Final approval automatically starts protected publication.`;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 24)}\n…message shortened`;
}
