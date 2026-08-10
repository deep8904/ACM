import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const articleTypeSchema = z.enum([
  "breaking_news",
  "news_analysis",
  "technical_explainer",
  "release_guide",
  "source_based_review",
  "buying_analysis",
  "comparison",
  "industry_analysis",
  "opinion_analysis",
  "tutorial_candidate",
]);
export type ArticleType = z.infer<typeof articleTypeSchema>;

export const draftClaimReferenceSchema = z
  .object({
    id: z.string().regex(/^draftclaim_[a-f0-9]{24}$/),
    draftId: z.string().regex(/^draft_[a-f0-9]{24}$/),
    statement: z.string().min(1).max(2000),
    claimType: z.enum([
      "fact",
      "specification",
      "timeline",
      "quote",
      "interpretation",
      "prediction",
      "opinion",
      "community_observation",
    ]),
    researchClaimIds: z.array(z.string().regex(/^claim_[a-f0-9]{24}$/)),
    sourceIds: z.array(z.string().regex(/^source_[a-f0-9]{24}$/)),
    section: z.string().min(1).max(300),
    supportStatus: z.enum([
      "supported",
      "partially_supported",
      "unsupported",
      "analysis",
      "opinion",
      "prediction",
    ]),
    notes: z.array(z.string().max(1000)),
  })
  .strict();
export type DraftClaimReference = z.infer<typeof draftClaimReferenceSchema>;

export const articleMetadataSchema = z
  .object({
    title: z.string().min(10).max(110),
    alternateTitles: z.array(z.string().min(10).max(110)).length(2),
    seoTitle: z.string().min(10).max(70),
    socialHeadline: z.string().min(5).max(100),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(90),
    description: z.string().min(80).max(180),
    excerpt: z.string().min(40).max(300),
    category: z.enum([
      "AI",
      "Software",
      "Development",
      "Hardware",
      "Design",
      "Gaming",
      "Game Development",
      "Creator Technology",
      "Product Analysis",
      "Industry",
    ]),
    tags: z.array(z.string().min(1).max(50)).min(1).max(8),
    author: z.literal("Deep"),
    heroImage: z.null(),
    heroAlt: z.string().min(1).max(220),
    canonicalUrl: z.null(),
    publishedAt: z.null(),
    status: z.literal("draft"),
    draft: z.literal(true),
  })
  .strict();

export const heroImageBriefSchema = z
  .object({
    editorialPurpose: z.string().min(1).max(1000),
    subject: z.string().min(1).max(1000),
    composition: z.string().min(1).max(1000),
    mood: z.string().min(1).max(500),
    background: z.string().min(1).max(500),
    aspectRatio: z.string().min(1).max(30),
    recommendation: z.enum([
      "official_press_imagery",
      "abstract_editorial",
      "diagram",
      "no_image",
    ]),
    mustNotDepict: z.array(z.string().max(300)),
    altTextDraft: z.string().min(1).max(220),
    misinformationRisk: z.string().min(1).max(1000),
  })
  .strict();

export const articleWritingResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    topicId: z.string().min(1),
    researchPacketId: z.string().regex(/^packet_[a-f0-9]{24}$/),
    researchPacketVersion: z.number().int().positive(),
    articleType: articleTypeSchema,
    metadata: articleMetadataSchema,
    mdx: z.string().min(1),
    plainTextSummary: z.string().min(40).max(2000),
    headingOutline: z
      .array(
        z
          .object({
            level: z.number().int().min(2).max(4),
            text: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(2),
    claimReferences: z.array(draftClaimReferenceSchema.omit({ draftId: true })),
    sourceIdsUsed: z.array(z.string().regex(/^source_[a-f0-9]{24}$/)),
    declaredAnalysisSections: z.array(z.string().max(300)),
    declaredOpinionSections: z.array(z.string().max(300)),
    limitations: z.array(z.string().min(1).max(1000)),
    heroImageBrief: heroImageBriefSchema,
    suggestedSeoMetadata: z
      .object({
        keywords: z.array(z.string().max(80)).max(12),
        searchIntent: z.string().max(500),
      })
      .strict(),
    writerNotes: z.array(z.string().max(1000)),
    unresolvedQuestions: z.array(z.string().max(1000)),
  })
  .strict();
export type ArticleWritingResult = z.infer<typeof articleWritingResultSchema>;

export const frontmatterSchema = z
  .object({
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    publishedAt: z.null(),
    updatedAt: iso,
    status: z.literal("draft"),
    category: articleMetadataSchema.shape.category,
    tags: z.array(z.string()),
    author: z.literal("Deep"),
    heroImage: z.null(),
    heroAlt: z.string(),
    canonicalUrl: z.null(),
    sources: z.array(z.string()),
    draft: z.literal(true),
    articleType: articleTypeSchema,
    readingTime: z.number().int().positive(),
    researchPacketId: z.string(),
    researchPacketVersion: z.number().int().positive(),
    sourceDisclosure: z.string(),
    reviewDisclosure: z.literal("Not editorially reviewed or approved"),
  })
  .strict();

export const citationCoverageSchema = z
  .object({
    coveredCriticalClaims: z.array(z.string()),
    uncoveredCriticalClaims: z.array(z.string()),
    unknownCitationMarkers: z.array(z.string()),
    citationDensity: z.number().nonnegative(),
    citationQualityWarnings: z.array(z.string()),
    score: z.number().min(0).max(100),
  })
  .strict();
export const draftQualityReportSchema = z
  .object({
    draftId: z.string(),
    draftVersion: z.number().int().positive(),
    status: z.enum(["passed", "passed_with_warnings", "blocked"]),
    wordCount: z.number().int().nonnegative(),
    readingTime: z.number().int().positive(),
    headingChecks: z.array(z.string()),
    frontmatterChecks: z.array(z.string()),
    mdxSafetyChecks: z.array(z.string()),
    citationCoverage: citationCoverageSchema,
    claimSupport: z.array(z.string()),
    forbiddenLanguage: z.array(z.string()),
    repetition: z.array(z.string()),
    linkChecks: z.array(z.string()),
    disclosureChecks: z.array(z.string()),
    blockingIssues: z.array(z.string()),
    warnings: z.array(z.string()),
    createdAt: iso,
  })
  .strict();
export type DraftQualityReport = z.infer<typeof draftQualityReportSchema>;

export const articleDraftSchema = z
  .object({
    id: z.string().regex(/^draft_[a-f0-9]{24}$/),
    topicId: z.string(),
    candidateId: z.string(),
    researchPacketId: z.string(),
    researchPacketVersion: z.number().int().positive(),
    approvedEventId: z.string(),
    version: z.number().int().positive(),
    status: z.enum([
      "preparing",
      "awaiting_manual_writing",
      "imported",
      "validated",
      "blocked",
      "superseded",
      "cancelled",
    ]),
    articleType: articleTypeSchema,
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    category: articleMetadataSchema.shape.category,
    tags: z.array(z.string()),
    author: z.literal("Deep"),
    heroImage: z.null(),
    heroAlt: z.string(),
    canonicalUrl: z.null(),
    publishedAt: z.null(),
    updatedAt: iso,
    draft: z.literal(true),
    mdx: z.string(),
    plainText: z.string(),
    wordCount: z.number().int().nonnegative(),
    readingTimeMinutes: z.number().int().positive(),
    headingOutline: articleWritingResultSchema.shape.headingOutline,
    sourceIds: z.array(z.string()),
    claimReferences: z.array(draftClaimReferenceSchema),
    researchContentHashes: z.array(hash),
    writingMode: z.enum([
      "manual_claude_code",
      "deterministic_placeholder",
      "future_api",
    ]),
    createdAt: iso,
    supersedesVersion: z.number().int().positive().optional(),
    provenance: z
      .object({
        taskHash: hash,
        importHash: hash,
        importedAt: iso,
        importedBy: z.literal("manual"),
        schemaVersion: z.literal("1.0"),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();
export type ArticleDraft = z.infer<typeof articleDraftSchema>;

export const writingJobSchema = z
  .object({
    id: z.string().regex(/^writingjob_[a-f0-9]{24}$/),
    topicId: z.string(),
    researchPacketId: z.string(),
    researchPacketVersion: z.number().int().positive(),
    articleType: articleTypeSchema,
    configHash: hash,
    taskHash: hash.optional(),
    researchContentHashes: z.array(hash),
    attempt: z.number().int().positive(),
    status: z.enum([
      "pending",
      "claimed",
      "preparing",
      "awaiting_manual_writing",
      "importing",
      "validating",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ]),
    startedAt: iso,
    heartbeatAt: iso,
    completedAt: iso.optional(),
    failedAt: iso.optional(),
    failureCode: z.string().optional(),
    failureMessage: z.string().optional(),
    draftId: z.string().optional(),
    workerId: z.string(),
    version: z.number().int().positive(),
  })
  .strict();
export type WritingJob = z.infer<typeof writingJobSchema>;

export const articleHistoryEntrySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    entities: z.array(z.string()),
    productIdentifiers: z.array(z.string()),
    keywords: z.array(z.string()),
    articleType: articleTypeSchema,
    summary: z.string(),
    date: iso,
    topicId: z.string(),
    researchContentHashes: z.array(hash),
    status: z.enum(["draft", "published"]),
  })
  .strict();
export type ArticleHistoryEntry = z.infer<typeof articleHistoryEntrySchema>;

export const firstHandEvidenceSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    product: z.string(),
    testDate: iso,
    testConditions: z.array(z.string()),
    notes: z.array(z.string()),
    mediaReferences: z.array(z.string()),
    approvalState: z.enum(["pending", "approved", "rejected"]),
  })
  .strict();
