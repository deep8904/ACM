import type { ResearchPacket } from "../research/models";
import type { ArticleDraft, DraftQualityReport } from "../writing/models";
import type { EditorialReviewResult, FinalApprovalRecord } from "./models";

export function assertReviewEligibility(input: {
  draft?: ArticleDraft;
  selectedVersion: number;
  latestDraftVersion: number;
  quality?: DraftQualityReport;
  packet?: ResearchPacket;
  topicActive: boolean;
  activeJob: boolean;
  finalApproval?: FinalApprovalRecord;
  latestResearchPacketVersion?: number;
}): asserts input is typeof input & {
  draft: ArticleDraft;
  quality: DraftQualityReport;
  packet: ResearchPacket;
} {
  const reasons: string[] = [];
  if (!Number.isInteger(input.selectedVersion) || input.selectedVersion < 1)
    reasons.push("an explicit positive draft version is required");
  if (!input.draft) reasons.push("selected draft does not exist");
  else {
    if (input.draft.version !== input.selectedVersion)
      reasons.push("selected draft version mismatch");
    if (input.draft.status !== "validated")
      reasons.push(`draft status is ${input.draft.status}`);
    if (
      !input.draft.draft ||
      input.draft.publishedAt ||
      input.draft.canonicalUrl ||
      input.draft.heroImage
    )
      reasons.push("draft publication fields are not eligible");
  }
  if (!input.quality || input.quality.status === "blocked")
    reasons.push("Milestone 5 quality is blocked or missing");
  if (
    !input.packet ||
    input.packet.status !== "ready" ||
    !input.packet.sufficient ||
    input.packet.blockingReasons.length
  )
    reasons.push("research packet is not ready and sufficient");
  if (
    input.draft &&
    input.packet &&
    input.draft.researchContentHashes.join() !==
      input.packet.contentHashes.join()
  )
    reasons.push("draft research hashes do not match the packet");
  if (!input.topicActive) reasons.push("topic approval is no longer active");
  if (input.activeJob) reasons.push("an active review job already exists");
  if (
    input.finalApproval &&
    ["approved", "scheduled"].includes(input.finalApproval.status)
  )
    reasons.push("this draft version already has final approval");
  if (input.latestDraftVersion > input.selectedVersion)
    reasons.push("a newer draft version supersedes the selected draft");
  if (
    input.draft &&
    input.latestResearchPacketVersion &&
    input.latestResearchPacketVersion > input.draft.researchPacketVersion
  )
    reasons.push("a newer research packet invalidates the selected draft");
  if (reasons.length)
    throw new Error(`Draft is not eligible for review: ${reasons.join("; ")}`);
}

export function assertFinalApprovalEligibility(input: {
  draft?: ArticleDraft;
  latestDraftVersion: number;
  review?: EditorialReviewResult;
  quality?: DraftQualityReport;
  packet?: ResearchPacket;
  topicActive: boolean;
  minimumCitationCoverage: number;
  pendingRevision: boolean;
  latestResearchPacketVersion?: number;
}): asserts input is typeof input & {
  draft: ArticleDraft;
  review: EditorialReviewResult;
  quality: DraftQualityReport;
  packet: ResearchPacket;
} {
  const reasons: string[] = [];
  if (
    !input.draft ||
    input.draft.status !== "validated" ||
    !input.draft.draft ||
    input.draft.publishedAt ||
    input.draft.canonicalUrl ||
    input.draft.heroImage
  )
    reasons.push("exact validated unpublished draft is required");
  if (input.draft && input.latestDraftVersion !== input.draft.version)
    reasons.push("a newer draft supersedes this version");
  if (
    !input.review ||
    !["pass", "pass_with_warnings"].includes(input.review.decision)
  )
    reasons.push("normalized review decision is not eligible");
  if (
    input.review?.issues.some(
      (x) =>
        x.status === "open" &&
        (x.severity === "critical" || (x.severity === "major" && x.blocking)),
    )
  )
    reasons.push("blocking editorial issues remain");
  if (input.review?.riskSummary.overall === "critical")
    reasons.push("critical editorial risk remains");
  if (
    !input.quality ||
    input.quality.status === "blocked" ||
    input.quality.citationCoverage.score < input.minimumCitationCoverage
  )
    reasons.push("quality or citation threshold failed");
  if (
    !input.packet ||
    input.packet.status !== "ready" ||
    !input.packet.sufficient ||
    input.packet.blockingReasons.length
  )
    reasons.push("research packet is no longer ready");
  if (
    input.draft &&
    input.packet &&
    input.draft.researchContentHashes.join() !==
      input.packet.contentHashes.join()
  )
    reasons.push("research hashes changed");
  if (!input.topicActive) reasons.push("topic approval is no longer active");
  if (input.pendingRevision)
    reasons.push("a mandatory revision remains pending");
  if (
    input.draft &&
    input.latestResearchPacketVersion &&
    input.latestResearchPacketVersion > input.draft.researchPacketVersion
  )
    reasons.push("a newer research packet invalidates this draft");
  if (reasons.length)
    throw new Error(`Final approval is not eligible: ${reasons.join("; ")}`);
}
