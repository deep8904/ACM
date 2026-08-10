import { resolve } from "node:path";
import { createRepositoryComposition } from "../storage/composition";
import { loadWritingConfig } from "../writing/config";
import { loadReviewConfig } from "./config";
import { FinalApprovalService } from "./final-approval";
import type { EditorialReviewResult } from "./models";
import { PreviewService } from "./preview";
import { RevisionService } from "./revision";
import { ReviewService } from "./service";

const [area = "review", command = "status"] = process.argv.slice(2);
const fixtureRoot = option("--fixtures");
const researchRoot = fixtureRoot
  ? `${fixtureRoot}/research`
  : (process.env.RESEARCH_STATE_DIRECTORY ?? "data/research");
const writingRoot = fixtureRoot
  ? `${fixtureRoot}/writing`
  : (process.env.WRITING_STATE_DIRECTORY ?? "data/writing");
const telegramRoot = fixtureRoot
  ? `${fixtureRoot}/telegram`
  : (process.env.TELEGRAM_STATE_DIRECTORY ?? "data/telegram");
const reviewRoot = fixtureRoot
  ? `${fixtureRoot}/review`
  : (process.env.REVIEW_STATE_DIRECTORY ?? "data/review");
const reviewTaskRoot = fixtureRoot
  ? `${fixtureRoot}/tasks/review`
  : (process.env.REVIEW_TASK_DIRECTORY ?? "data/tasks/review");
const revisionTaskRoot = fixtureRoot
  ? `${fixtureRoot}/tasks/revision`
  : (process.env.REVISION_TASK_DIRECTORY ?? "data/tasks/revision");
const finalRoot = fixtureRoot
  ? `${fixtureRoot}/final-approval`
  : (process.env.FINAL_APPROVAL_STATE_DIRECTORY ?? "data/final-approval");
const eventRoot = fixtureRoot
  ? `${fixtureRoot}/events/article-final-approved`
  : (process.env.ARTICLE_EVENT_DIRECTORY ??
    "data/events/article-final-approved");
const config = await loadReviewConfig(
  process.env.REVIEW_CONFIG ?? "automation/config/review.example.yaml",
);
const writingConfig = await loadWritingConfig(
  process.env.WRITING_CONFIG ?? "automation/config/writing.example.yaml",
);
const topicId = option("--topic-id");
const draftVersion = positive("--draft-version");
const reviewVersion = positive("--review-version");

const composition = createRepositoryComposition(
  fixtureRoot
    ? {
        ...process.env,
        NODE_ENV: "test",
        STORAGE_BACKEND: "file",
        RESEARCH_STATE_DIRECTORY: researchRoot,
        WRITING_STATE_DIRECTORY: writingRoot,
        TELEGRAM_STATE_DIRECTORY: telegramRoot,
        REVIEW_STATE_DIRECTORY: reviewRoot,
        REVIEW_TASK_DIRECTORY: reviewTaskRoot,
        REVISION_TASK_DIRECTORY: revisionTaskRoot,
        FINAL_APPROVAL_STATE_DIRECTORY: finalRoot,
        ARTICLE_EVENT_DIRECTORY: eventRoot,
      }
    : process.env,
);
await composition.verify();
const { drafts, quality, history } = composition.writing;
const packets = composition.research.packets;
const { reviews, jobs, approvals, events, previews, revisions, gates, tasks } =
  composition.review;
const reviewService = new ReviewService({
  drafts,
  quality,
  packets,
  jobs,
  reviews,
  tasks,
  approvals,
  gates,
  config,
  paths: {
    reviewPrompt: "prompts/editorial-review.md",
    audience: "brand/audience.md",
    style: "brand/writing-style.md",
    editorial: "brand/editorial-rules.md",
  },
});
const revisionService = new RevisionService({
  drafts,
  quality,
  packets,
  reviews,
  tasks: revisions,
  approvals,
  events,
  previews,
  gates,
  history,
  writingConfig,
});
const finalService = new FinalApprovalService({
  drafts,
  quality,
  packets,
  reviews,
  revisions,
  approvals,
  events,
  gates,
  config,
});
const actor = {
  telegramChatId: option("--chat-id") ?? "0",
  telegramUserId: option("--user-id") ?? "0",
  telegramUpdateId: Number(option("--update-id") ?? Date.now()),
};

let output: unknown;
if (area === "review") {
  requireTopic();
  if (command === "prepare") {
    requireDraft();
    output = await reviewService.prepare(topicId!, draftVersion!);
  } else if (command === "status")
    output = await reviewService.status(
      topicId!,
      draftVersion ?? (await drafts.get(topicId!))?.version ?? 0,
    );
  else if (command === "task") {
    const version = requireDraft();
    output = {
      topicId,
      draftVersion: version,
      available: Boolean(await tasks.readInput(topicId!, version)),
      taskDirectory:
        composition.backend === "postgres"
          ? `postgres://content_machine/review_tasks/${topicId}/v${version}`
          : resolve(reviewTaskRoot, topicId!, `draft-v${version}`),
    };
  } else if (command === "import") {
    const imported = await reviewService.import(
      topicId!,
      requireDraft(),
      required("--file"),
    );
    output = summarizeReview(imported.review, imported.reused);
  } else if (command === "report") {
    const report = await reviewService.report(
      topicId!,
      requireDraft(),
      reviewVersion,
    );
    output = report ? summarizeReview(report, false) : undefined;
  } else throw new Error(`Unknown review command: ${command}`);
} else if (area === "revise") {
  requireTopic();
  if (command === "prepare") {
    const ids = required("--issue-ids").split(",").filter(Boolean);
    output = await revisionService.prepare(topicId!, requireDraft(), ids, {
      scope: option("--scope") as never,
      requestedChange: option("--instruction"),
      origin: "cli",
    });
  } else if (command === "import") {
    const result = await revisionService.import(
      topicId!,
      requireDraft(),
      required("--file"),
    );
    output = {
      reused: result.reused,
      draftId: result.draft.id,
      draftVersion: result.draft.version,
      status: result.draft.status,
      qualityStatus: result.quality?.status,
    };
  } else throw new Error(`Unknown revise command: ${command}`);
} else if (area === "preview") {
  requireTopic();
  output = await new PreviewService({
    drafts,
    previews,
    gates,
    config,
  }).create(topicId!, requireDraft());
} else if (area === "final") {
  requireTopic();
  if (command === "status") output = await finalService.status(topicId!);
  else if (command === "approve")
    output = await finalService.act(
      topicId!,
      requireDraft(),
      requireReview(),
      "approve_publish",
      actor,
      { notes: option("--note") ? [option("--note")!] : [] },
    );
  else if (command === "schedule")
    output = await finalService.act(
      topicId!,
      requireDraft(),
      requireReview(),
      "approve_schedule",
      actor,
      {
        scheduledFor: required("--publish-at"),
        notes: option("--note") ? [option("--note")!] : [],
      },
    );
  else if (command === "cancel")
    output = await finalService.cancel(topicId!, actor, option("--note"));
  else throw new Error(`Unknown final command: ${command}`);
} else throw new Error(`Unknown review area: ${area}`);

process.stdout.write(
  `${JSON.stringify(output ?? { status: "not_found" }, null, 2)}\n`,
);
await composition.close();

function summarizeReview(review: EditorialReviewResult, reused: boolean) {
  return {
    reused,
    reviewId: review.id,
    reviewVersion: review.version,
    draftVersion: review.draftVersion,
    importedDecision: review.importedDecision,
    decision: review.decision,
    issueCount: review.issues.length,
    risk: review.riskSummary.overall,
  };
}
function option(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function required(name: string) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return resolveIfFile(name, value);
}
function resolveIfFile(name: string, value: string) {
  return name === "--file" ? resolve(value) : value;
}
function positive(name: string) {
  const raw = option(name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
function requireTopic() {
  if (!topicId) throw new Error("--topic-id is required");
  if (!/^[A-Za-z0-9_-]+$/.test(topicId))
    throw new Error("--topic-id contains unsafe characters");
}
function requireDraft(): number {
  if (!draftVersion) throw new Error("--draft-version is required");
  return draftVersion;
}
function requireReview(): number {
  if (!reviewVersion) throw new Error("--review-version is required");
  return reviewVersion;
}
