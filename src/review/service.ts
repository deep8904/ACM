import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ResearchPacketRepository } from "../research/interfaces";
import { inspectMdx } from "../writing/mdx";
import type {
  ArticleDraftRepository,
  DraftQualityRepository,
} from "../writing/interfaces";
import { sha256 } from "../writing/task";
import type { ReviewConfig } from "./config";
import {
  classifyEditorialRisk,
  runDeterministicEditorialReview,
} from "./deterministic";
import { assertReviewEligibility } from "./eligibility";
import type {
  EditorialReviewJobRepository,
  EditorialReviewRepository,
  FinalApprovalRepository,
  ReviewGateRepository,
  ReviewTaskRepository,
} from "./interfaces";
import {
  editorialReviewImportSchema,
  editorialReviewJobSchema,
  editorialReviewResultSchema,
  type EditorialIssue,
  type EditorialReviewJob,
} from "./models";
import { createReviewTask } from "./task";

const taskInputSchema = z
  .object({
    topicId: z.string(),
    draftId: z.string(),
    draftVersion: z.number().int(),
    articleHash: z.string(),
    researchPacketId: z.string(),
    researchPacketVersion: z.number().int(),
    researchContentHashes: z.array(z.string()),
  })
  .passthrough();
export interface ReviewServiceDependencies {
  drafts: ArticleDraftRepository;
  quality: DraftQualityRepository;
  packets: ResearchPacketRepository;
  jobs: EditorialReviewJobRepository;
  reviews: EditorialReviewRepository;
  tasks: ReviewTaskRepository;
  approvals: FinalApprovalRepository;
  gates: ReviewGateRepository;
  config: ReviewConfig;
  paths: {
    reviewPrompt: string;
    audience: string;
    style: string;
    editorial: string;
  };
  clock?: () => Date;
  workerId?: string;
}

export class ReviewService {
  constructor(private deps: ReviewServiceDependencies) {}
  private now() {
    return (this.deps.clock ?? (() => new Date()))();
  }
  async prepare(topicId: string, draftVersion: number) {
    if (!Number.isInteger(draftVersion) || draftVersion < 1)
      throw new Error("An explicit positive draft version is required");
    const draft = await this.deps.drafts.get(topicId, draftVersion);
    const latest = await this.deps.drafts.get(topicId);
    const quality = await this.deps.quality.get(topicId, draftVersion);
    const packet = draft
      ? await this.deps.packets.get(topicId, draft.researchPacketVersion)
      : undefined;
    const latestPacket = await this.deps.packets.get(topicId);
    const previous = await this.deps.jobs.get(topicId, draftVersion);
    const approval = await this.deps.approvals.get(topicId);
    const topicActive = draft
      ? await this.deps.gates.topicActive(topicId, draft.approvedEventId)
      : false;
    const activeJob = Boolean(
      previous &&
      ![
        "awaiting_manual_review",
        "failed",
        "blocked",
        "cancelled",
        "completed",
        "revision_required",
        "ready_for_final_approval",
      ].includes(previous.status),
    );
    assertReviewEligibility({
      draft,
      selectedVersion: draftVersion,
      latestDraftVersion: latest?.version ?? 0,
      quality,
      packet,
      topicActive,
      activeJob,
      finalApproval:
        approval?.draftVersion === draftVersion ? approval : undefined,
      latestResearchPacketVersion: latestPacket?.version,
    });
    if (!draft || !quality || !packet)
      throw new Error("Review eligibility inputs are unavailable");
    let job = await this.deps.jobs.claim(
      draft,
      this.deps.workerId ?? `local-${process.pid}`,
      this.now().toISOString(),
    );
    if (
      [
        "awaiting_manual_review",
        "ready_for_final_approval",
        "revision_required",
        "completed",
      ].includes(job.status) &&
      job.taskHash
    )
      return {
        job,
        taskDirectory: `data/tasks/review/${topicId}/draft-v${draftVersion}`,
      };
    const now = this.now().toISOString();
    job = await this.update(job, { status: "preparing", heartbeatAt: now });
    const deterministic = runDeterministicEditorialReview(
      draft,
      quality,
      packet,
      this.deps.config,
      now,
    );
    const bundle = await createReviewTask(
      draft,
      quality,
      packet,
      deterministic,
      this.deps.config,
      {
        prompt: this.deps.paths.reviewPrompt,
        audience: this.deps.paths.audience,
        style: this.deps.paths.style,
        editorial: this.deps.paths.editorial,
      },
      now,
    );
    if (!(await this.deps.gates.topicActive(topicId, draft.approvedEventId))) {
      await this.update(job, { status: "cancelled", heartbeatAt: now });
      throw new Error("Topic was cancelled before review task persistence");
    }
    const taskDirectory = await this.deps.tasks.write(
      topicId,
      draftVersion,
      bundle.files,
    );
    job = await this.update(job, {
      status: "awaiting_manual_review",
      heartbeatAt: now,
      taskHash: bundle.taskHash,
    });
    return { job, deterministic, taskDirectory };
  }
  async import(topicId: string, draftVersion: number, path: string) {
    const raw = await readFile(path, "utf8");
    if (raw.length > 200_000)
      throw new Error("Editorial review result is oversized");
    const importHash = sha256(raw);
    const reused = await this.deps.reviews.findByImportHash(importHash);
    if (reused) return { review: reused, reused: true };
    const imported = editorialReviewImportSchema.parse(JSON.parse(raw));
    if (!this.deps.config.allowedReviewDecisions.includes(imported.decision))
      throw new Error("Imported review decision is disabled by configuration");
    if (imported.issues.some((issue) => issue.status !== "open"))
      throw new Error("Newly imported editorial issues must be open");
    const draft = await this.deps.drafts.get(topicId, draftVersion);
    const quality = await this.deps.quality.get(topicId, draftVersion);
    if (!draft || !quality)
      throw new Error("Selected draft and quality report are required");
    const packet = await this.deps.packets.get(
      topicId,
      draft.researchPacketVersion,
    );
    if (!packet) throw new Error("Research packet is missing");
    let job = await this.deps.jobs.get(topicId, draftVersion);
    if (
      !job?.taskHash ||
      ![
        "awaiting_manual_review",
        "revision_required",
        "ready_for_final_approval",
      ].includes(job.status)
    )
      throw new Error("A prepared review job is required before import");
    const expectedId = `review_${sha256(`${draft.id}:${draft.version}`).slice(0, 24)}`;
    if (
      imported.id !== expectedId ||
      imported.draftId !== draft.id ||
      imported.draftVersion !== draft.version ||
      imported.researchPacketId !== packet.id ||
      imported.researchPacketVersion !== packet.version ||
      imported.provenance.taskHash !== job.taskHash
    )
      throw new Error("Review result identity or task provenance mismatch");
    const task = taskInputSchema.parse(
      await this.deps.tasks.readInput(topicId, draftVersion),
    );
    if (
      task.articleHash !== sha256(JSON.stringify(draft)) ||
      task.researchContentHashes.join() !== packet.contentHashes.join()
    )
      throw new Error("Draft or research changed after task preparation");
    const issueIds = imported.issues.map((x) => x.id);
    if (new Set(issueIds).size !== issueIds.length)
      throw new Error("Duplicate editorial issue IDs are not allowed");
    validateIssues(imported.issues, draft, packet);
    job = await this.update(job, {
      status: "importing",
      heartbeatAt: this.now().toISOString(),
    });
    const now = this.now().toISOString();
    job = await this.update(job, { status: "validating", heartbeatAt: now });
    const deterministic = runDeterministicEditorialReview(
      draft,
      quality,
      packet,
      this.deps.config,
      now,
    );
    const issues = mergeIssues(deterministic.issues, imported.issues);
    const decision = normalizeDecision(
      imported.decision,
      issues,
      deterministic.citationCoverageScore,
      quality.status,
      this.deps.config.minimumCitationCoverage,
    );
    const version = await this.deps.reviews.nextVersion(topicId, draftVersion);
    const review = editorialReviewResultSchema.parse({
      ...imported,
      topicId,
      version,
      importedDecision: imported.decision,
      decision,
      issues,
      riskSummary: classifyEditorialRisk(issues),
      deterministicReportHash: sha256(JSON.stringify(deterministic)),
      provenance: {
        ...imported.provenance,
        importHash,
        importedAt: now,
        importedBy: "manual",
      },
    });
    await this.deps.reviews.save(review, deterministic, {
      inputPath: path,
      importHash,
      taskHash: job.taskHash,
      importedAt: now,
      articleHash: task.articleHash,
      researchContentHashes: packet.contentHashes,
    });
    const status =
      decision === "block"
        ? "blocked"
        : decision === "revise"
          ? "revision_required"
          : "ready_for_final_approval";
    await this.update(job, {
      status,
      heartbeatAt: now,
      completedAt: now,
      reviewId: review.id,
      ...(decision === "block"
        ? {
            failedAt: now,
            failureCode: "EDITORIAL_BLOCKED",
            failureMessage: issues
              .filter((x) => x.blocking)
              .map((x) => x.title)
              .join("; "),
          }
        : {}),
    });
    return { review, deterministic, reused: false };
  }
  status(topicId: string, draftVersion: number) {
    return this.deps.jobs.get(topicId, draftVersion);
  }
  report(topicId: string, draftVersion: number, reviewVersion?: number) {
    return this.deps.reviews.get(topicId, draftVersion, reviewVersion);
  }
  private async update(
    job: EditorialReviewJob,
    change: Partial<EditorialReviewJob>,
  ) {
    const value = editorialReviewJobSchema.parse({
      ...job,
      ...change,
      version: job.version + 1,
    });
    await this.deps.jobs.save(value);
    return value;
  }
}

function validateIssues(
  issues: EditorialIssue[],
  draft: NonNullable<Awaited<ReturnType<ArticleDraftRepository["get"]>>>,
  packet: NonNullable<Awaited<ReturnType<ResearchPacketRepository["get"]>>>,
) {
  const references = new Set(draft.claimReferences.map((x) => x.id));
  const sources = new Set(packet.sourceIndex.map((x) => x.id));
  const sections = new Set(
    inspectMdx(draft.mdx, sources).headings.map((x) => x.text.toLowerCase()),
  );
  const factualText = `${draft.plainText} ${packet.executiveSummary} ${[...packet.facts, ...packet.interpretations].map((x) => x.statement).join(" ")}`;
  const numbers = new Set(factualText.match(/\b\d+(?:[.,]\d+)*\b/g) ?? []);
  for (const issue of issues) {
    if (issue.claimReferenceIds.some((id) => !references.has(id)))
      throw new Error(`Unknown draft claim reference in issue ${issue.id}`);
    if (issue.sourceIds.some((id) => !sources.has(id)))
      throw new Error(`Unknown source in issue ${issue.id}`);
    if (issue.section && !sections.has(issue.section.toLowerCase()))
      throw new Error(`Unknown article section in issue ${issue.id}`);
    if (
      (issue.suggestedCorrection?.match(/\b\d+(?:[.,]\d+)*\b/g) ?? []).some(
        (x) => !numbers.has(x),
      )
    )
      throw new Error(
        `Suggested correction in ${issue.id} introduces an unsupported numeric assertion`,
      );
  }
}
function mergeIssues(
  deterministic: EditorialIssue[],
  imported: EditorialIssue[],
) {
  const result = new Map(imported.map((x) => [x.id, x]));
  for (const issue of deterministic) {
    const supplied = result.get(issue.id);
    const nonWaivable =
      [
        "factual_support",
        "source_misrepresentation",
        "first_hand_claim",
        "mdx",
        "product_disclosure",
        "conflicting_evidence",
      ].includes(issue.category) &&
      (issue.severity === "critical" || issue.blocking);
    result.set(issue.id, supplied && !nonWaivable ? supplied : issue);
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function normalizeDecision(
  imported: string,
  issues: EditorialIssue[],
  coverage: number,
  qualityStatus: string,
  minimum: number,
) {
  const open = issues.filter((x) => x.status === "open");
  if (
    qualityStatus === "blocked" ||
    coverage < minimum ||
    open.some((x) => x.severity === "critical")
  )
    return "block" as const;
  if (imported === "block") return "block" as const;
  if (imported === "revise" || open.some((x) => x.severity === "major"))
    return "revise" as const;
  if (open.length || imported === "pass_with_warnings")
    return "pass_with_warnings" as const;
  return "pass" as const;
}
