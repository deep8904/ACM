import { z } from "zod";
import {
  articleTypeSchema,
  draftClaimReferenceSchema,
} from "../writing/models";

const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaque24 = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{24}$`));

export const editorialIssueCategorySchema = z.enum([
  "factual_support",
  "source_misrepresentation",
  "missing_uncertainty",
  "conflicting_evidence",
  "headline_accuracy",
  "structure",
  "clarity",
  "repetition",
  "brand_voice",
  "ai_style",
  "legal_risk",
  "copyright",
  "product_disclosure",
  "first_hand_claim",
  "citation",
  "seo",
  "mdx",
  "accessibility",
  "other",
]);
export type EditorialIssueCategory = z.infer<
  typeof editorialIssueCategorySchema
>;
export const editorialIssueSeveritySchema = z.enum([
  "info",
  "warning",
  "major",
  "critical",
]);
export type EditorialIssueSeverity = z.infer<
  typeof editorialIssueSeveritySchema
>;
export const editorialIssueStatusSchema = z.enum([
  "open",
  "accepted",
  "rejected",
  "resolved",
  "waived",
]);
export const editorialIssueSchema = z
  .object({
    id: opaque24("issue"),
    category: editorialIssueCategorySchema,
    severity: editorialIssueSeveritySchema,
    status: editorialIssueStatusSchema,
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    section: z.string().min(1).max(300).optional(),
    paragraphReference: z.string().max(300).optional(),
    claimReferenceIds: z.array(opaque24("draftclaim")),
    sourceIds: z.array(opaque24("source")),
    suggestedCorrection: z.string().max(2000).optional(),
    blocking: z.boolean(),
    createdAt: iso,
    resolvedAt: iso.optional(),
    resolutionNotes: z.string().max(2000).optional(),
  })
  .strict();
export type EditorialIssue = z.infer<typeof editorialIssueSchema>;

export const riskLabelSchema = z.enum(["low", "moderate", "high", "critical"]);
export const editorialRiskSummarySchema = z
  .object({
    factual: riskLabelSchema,
    source: riskLabelSchema,
    legalReputational: riskLabelSchema,
    copyright: riskLabelSchema,
    productDisclosure: riskLabelSchema,
    timeliness: riskLabelSchema,
    brandConsistency: riskLabelSchema,
    technicalAccuracy: riskLabelSchema,
    publicationReadiness: riskLabelSchema,
    overall: riskLabelSchema,
    explanations: z.array(z.string().max(1000)),
  })
  .strict();
export type EditorialRiskSummary = z.infer<typeof editorialRiskSummarySchema>;

export const reviewDecisionSchema = z.enum([
  "pass",
  "pass_with_warnings",
  "revise",
  "block",
]);
const assessment = z
  .object({
    rating: z.enum(["strong", "acceptable", "needs_work", "blocking"]),
    notes: z.array(z.string().max(1000)),
  })
  .strict();
export const editorialReviewImportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: opaque24("review"),
    draftId: opaque24("draft"),
    draftVersion: z.number().int().positive(),
    researchPacketId: opaque24("packet"),
    researchPacketVersion: z.number().int().positive(),
    decision: reviewDecisionSchema,
    summary: z.string().min(1).max(3000),
    strengths: z.array(z.string().max(1000)),
    issues: z.array(editorialIssueSchema),
    requiredRevisions: z.array(z.string().max(2000)),
    optionalImprovements: z.array(z.string().max(2000)),
    headlineAssessment: assessment,
    sourceAssessment: assessment,
    claimAssessment: assessment,
    styleAssessment: assessment,
    structureAssessment: assessment,
    riskAssessment: assessment,
    seoAssessment: assessment,
    recommendedTitle: z.string().min(10).max(110).optional(),
    recommendedDescription: z.string().min(80).max(180).optional(),
    recommendedArticleType: articleTypeSchema.optional(),
    unresolvedQuestions: z.array(z.string().max(1000)),
    reviewerNotes: z.array(z.string().max(1000)),
    createdAt: iso,
    provenance: z
      .object({ mode: z.literal("manual_claude_code"), taskHash: hash })
      .strict(),
  })
  .strict();
export type EditorialReviewImport = z.infer<typeof editorialReviewImportSchema>;
export const editorialReviewResultSchema = editorialReviewImportSchema
  .extend({
    topicId: z.string().min(1),
    version: z.number().int().positive(),
    importedDecision: reviewDecisionSchema,
    decision: reviewDecisionSchema,
    riskSummary: editorialRiskSummarySchema,
    deterministicReportHash: hash,
    provenance: editorialReviewImportSchema.shape.provenance
      .extend({
        importHash: hash,
        importedAt: iso,
        importedBy: z.literal("manual"),
      })
      .strict(),
  })
  .strict();
export type EditorialReviewResult = z.infer<typeof editorialReviewResultSchema>;

export const editorialReviewJobSchema = z
  .object({
    id: opaque24("reviewjob"),
    topicId: z.string().min(1),
    draftId: opaque24("draft"),
    draftVersion: z.number().int().positive(),
    researchPacketId: opaque24("packet"),
    researchPacketVersion: z.number().int().positive(),
    attempt: z.number().int().positive(),
    status: z.enum([
      "pending",
      "claimed",
      "preparing",
      "awaiting_manual_review",
      "importing",
      "validating",
      "revision_required",
      "ready_for_final_approval",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ]),
    taskHash: hash.optional(),
    startedAt: iso,
    heartbeatAt: iso,
    completedAt: iso.optional(),
    failedAt: iso.optional(),
    failureCode: z.string().max(100).optional(),
    failureMessage: z.string().max(2000).optional(),
    reviewId: opaque24("review").optional(),
    workerId: z.string().min(1).max(200),
    version: z.number().int().positive(),
  })
  .strict();
export type EditorialReviewJob = z.infer<typeof editorialReviewJobSchema>;

export const deterministicEditorialReportSchema = z
  .object({
    id: opaque24("detreview"),
    topicId: z.string(),
    draftId: opaque24("draft"),
    draftVersion: z.number().int().positive(),
    qualityReportHash: hash,
    status: z.enum(["eligible", "eligible_with_warnings", "blocked"]),
    issues: z.array(editorialIssueSchema),
    riskSummary: editorialRiskSummarySchema,
    citationCoverageScore: z.number().min(0).max(100),
    blockingIssueCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    checks: z.array(
      z
        .object({
          code: z.string(),
          passed: z.boolean(),
          explanation: z.string(),
        })
        .strict(),
    ),
    createdAt: iso,
  })
  .strict();
export type DeterministicEditorialReport = z.infer<
  typeof deterministicEditorialReportSchema
>;

export const revisionScopeSchema = z.enum([
  "title_only",
  "description_only",
  "introduction_only",
  "section_only",
  "citation_fix",
  "disclosure_fix",
  "tone_adjustment",
  "structure_adjustment",
  "full_revision",
]);
export type RevisionScope = z.infer<typeof revisionScopeSchema>;
export const revisionRequestSchema = z
  .object({
    id: opaque24("revision"),
    topicId: z.string(),
    draftId: opaque24("draft"),
    draftVersion: z.number().int().positive(),
    issueIds: z.array(opaque24("issue")),
    requestedChange: z.string().min(1).max(3000),
    sectionsAffected: z.array(z.string().max(300)),
    claimReferenceIds: z.array(opaque24("draftclaim")),
    sourceIdsThatMustRemain: z.array(opaque24("source")),
    protectedResearchClaimIds: z.array(opaque24("claim")),
    allowTitleChange: z.boolean(),
    allowDescriptionChange: z.boolean(),
    allowStructureChange: z.boolean(),
    allowBodyChange: z.boolean(),
    scope: revisionScopeSchema,
    origin: z.enum([
      "editorial_review",
      "telegram",
      "cli",
      "deterministic_quality",
    ]),
    createdAt: iso,
    status: z.enum(["pending", "task_ready", "completed", "cancelled"]),
    version: z.number().int().positive(),
  })
  .strict();
export type RevisionRequest = z.infer<typeof revisionRequestSchema>;
export const revisionResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    topicId: z.string(),
    sourceDraftId: opaque24("draft"),
    sourceDraftVersion: z.number().int().positive(),
    revisionScope: revisionScopeSchema,
    addressedIssueIds: z.array(opaque24("issue")),
    title: z.string().min(10).max(110),
    alternateTitles: z.array(z.string().min(10).max(110)).length(2),
    description: z.string().min(80).max(180),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    mdx: z.string().min(1),
    claimReferences: z.array(draftClaimReferenceSchema.omit({ draftId: true })),
    sourceIdsUsed: z.array(opaque24("source")),
    changeSummary: z.string().min(1).max(2000),
    writerNotes: z.array(z.string().max(1000)),
    unresolvedIssues: z.array(opaque24("issue")),
    provenance: z
      .object({ mode: z.literal("manual_claude_code"), taskHash: hash })
      .strict(),
  })
  .strict();
export type RevisionResult = z.infer<typeof revisionResultSchema>;

export const finalApprovalActionSchema = z.enum([
  "approve_publish",
  "approve_schedule",
  "request_changes",
  "hold",
  "reject",
]);
export const finalApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "scheduled",
  "changes_requested",
  "held",
  "rejected",
  "cancelled",
  "superseded",
]);
export const finalApprovalRecordSchema = z
  .object({
    id: opaque24("finalapproval"),
    shortId: z.string().regex(/^[a-f0-9]{12}$/),
    topicId: z.string(),
    draftId: opaque24("draft"),
    draftVersion: z.number().int().positive(),
    reviewId: opaque24("review"),
    reviewVersion: z.number().int().positive(),
    telegramChatId: z.string().regex(/^-?\d+$/),
    telegramUserId: z.string().regex(/^\d+$/),
    status: finalApprovalStatusSchema,
    action: finalApprovalActionSchema.optional(),
    approvalNotes: z.array(z.string().max(2000)),
    scheduledAt: iso.optional(),
    scheduleTimezone: z.string().max(100).optional(),
    createdAt: iso,
    updatedAt: iso,
    telegramUpdateId: z.number().int().nonnegative(),
    telegramMessageId: z.number().int().nonnegative().optional(),
    callbackQueryId: z.string().max(256).optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type FinalApprovalRecord = z.infer<typeof finalApprovalRecordSchema>;

export const articleFinalApprovedEventSchema = z
  .object({
    id: opaque24("articleevent"),
    topicId: z.string(),
    candidateId: z.string(),
    draftId: opaque24("draft"),
    draftVersion: z.number().int().positive(),
    reviewId: opaque24("review"),
    reviewVersion: z.number().int().positive(),
    researchPacketId: opaque24("packet"),
    researchPacketVersion: z.number().int().positive(),
    approvedAt: iso,
    approvedBy: z
      .object({
        telegramUserId: z.string().regex(/^\d+$/),
        telegramChatId: z.string().regex(/^-?\d+$/),
      })
      .strict(),
    approvalNotes: z.array(z.string().max(2000)),
    requestedPublishAt: iso.optional(),
    requestedTimezone: z.string().optional(),
    articleSnapshotHash: hash,
    sourceIds: z.array(opaque24("source")),
    origin: z.enum(["ranked", "manual_topic", "manual_url"]),
    status: z.enum([
      "ready_for_publication",
      "scheduled",
      "cancelled",
      "superseded",
      "consumed",
    ]),
    createdAt: iso,
    version: z.number().int().positive(),
  })
  .strict();
export type ArticleFinalApprovedEvent = z.infer<
  typeof articleFinalApprovedEventSchema
>;

export const draftPreviewSchema = z
  .object({
    id: opaque24("preview"),
    topicId: z.string(),
    draftId: opaque24("draft"),
    draftVersion: z.number().int().positive(),
    articleHash: hash,
    path: z.string(),
    createdAt: iso,
    expiresAt: iso,
    status: z.enum(["active", "superseded", "expired", "cancelled"]),
  })
  .strict();
export type DraftPreview = z.infer<typeof draftPreviewSchema>;

export const finalConversationStateSchema = z
  .object({
    id: opaque24("finalconversation"),
    chatId: z.string().regex(/^-?\d+$/),
    userId: z.string().regex(/^\d+$/),
    state: z.enum([
      "awaiting_final_change_request",
      "awaiting_schedule_time",
      "awaiting_article_rejection_reason",
      "awaiting_final_approval_note",
    ]),
    topicId: z.string(),
    draftVersion: z.number().int().positive(),
    reviewVersion: z.number().int().positive(),
    createdAt: iso,
    expiresAt: iso,
    version: z.number().int().positive(),
  })
  .strict();
export type FinalConversationState = z.infer<
  typeof finalConversationStateSchema
>;
