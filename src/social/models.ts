import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{24}$`));
export const socialPlatformSchema = z.enum([
  "linkedin",
  "x",
  "instagram",
  "medium",
]);
export type SocialPlatform = z.infer<typeof socialPlatformSchema>;
export const socialPublisherCapabilitiesSchema = z
  .object({
    canAutoPost: z.boolean(),
    supportsImages: z.boolean(),
    supportsCarousel: z.boolean(),
    supportsThreads: z.boolean(),
    supportsDrafts: z.boolean(),
  })
  .strict();
export type SocialPublisherCapabilities = z.infer<
  typeof socialPublisherCapabilitiesSchema
>;
export const socialGenerationModeSchema = z.enum([
  "manual_claude_code",
  "manual_gemini",
  "deterministic_placeholder",
  "future_api",
]);
export const socialJobSchema = z
  .object({
    id: opaque("socialjob"),
    publicationId: opaque("publication"),
    topicId: z.string(),
    articleSlug: z.string(),
    articleContentHash: hash,
    attempt: z.number().int().positive(),
    status: z.enum([
      "pending",
      "claimed",
      "preparing",
      "awaiting_manual_generation",
      "importing",
      "validating",
      "ready_for_social_approval",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ]),
    startedAt: iso,
    heartbeatAt: iso,
    completedAt: iso.optional(),
    failedAt: iso.optional(),
    failureCode: z.string().max(100).optional(),
    failureMessage: z.string().max(1000).optional(),
    packageId: opaque("socialpackage").optional(),
    taskHash: hash.optional(),
    selectedPlatforms: z.array(socialPlatformSchema).optional(),
    packageVersion: z.number().int().positive().optional(),
    workerId: z.string().min(1).max(200),
    version: z.number().int().positive(),
  })
  .strict();
export type SocialGenerationJob = z.infer<typeof socialJobSchema>;

export const socialClaimSchema = z
  .object({
    id: z.string().regex(/^pubclaim_[a-f0-9]{16}$/),
    section: z.string().max(200),
    statement: z.string().min(1).max(1000),
    fingerprint: hash,
    claimType: z.enum([
      "fact",
      "analysis",
      "recommendation",
      "disclosure",
      "uncertainty",
    ]),
    compressionAllowed: z.boolean(),
    publicSourceUrls: z.array(z.string().url()).max(10),
  })
  .strict();
export type SocialClaim = z.infer<typeof socialClaimSchema>;
export const carouselSlideSchema = z
  .object({
    slideNumber: z.number().int().positive(),
    headline: z.string().min(1).max(120),
    body: z.string().min(1).max(400),
    visualDirection: z.string().min(1).max(800),
    altText: z.string().min(1).max(500),
  })
  .strict();
export const visualBriefSchema = z
  .object({
    platform: socialPlatformSchema,
    purpose: z.string().min(1).max(500),
    subject: z.string().min(1).max(500),
    composition: z.string().min(1).max(500),
    aspectRatio: z.string().min(1).max(30),
    typographyNeeds: z.string().max(500),
    background: z.string().max(500),
    mood: z.string().max(300),
    brandAlignment: z.string().max(500),
    recommendation: z.enum([
      "abstract",
      "editorial",
      "diagrammatic",
      "official_asset",
      "product_based",
    ]),
    officialAssetPreference: z.boolean(),
    prohibitedElements: z.array(z.string().max(200)),
    misinformationRisk: z.string().min(1).max(500),
    altTextDraft: z.string().min(1).max(500),
  })
  .strict();
export const imagePromptSchema = z
  .object({
    platform: socialPlatformSchema,
    prompt: z.string().min(1).max(3000),
    aspectRatio: z.string().min(1).max(30),
    style: z.enum(["abstract", "editorial", "diagrammatic", "product_based"]),
    negativeInstructions: z.array(z.string().min(1).max(300)).min(1),
    altTextIntent: z.string().min(1).max(500),
  })
  .strict();
export const socialDisclosureSchema = z
  .object({
    relationship: z.enum([
      "sponsorship",
      "affiliate",
      "free_review_sample",
      "paid_partnership",
      "employer_relationship",
    ]),
    statement: z.string().min(1).max(500),
    platforms: z.array(socialPlatformSchema).min(1),
    claimReference: z.string().regex(/^pubclaim_[a-f0-9]{16}$/),
  })
  .strict();
export const platformContentItemSchema = z
  .object({
    id: opaque("socialitem"),
    platform: socialPlatformSchema,
    contentType: z.enum([
      "linkedin_post",
      "x_post",
      "x_thread",
      "instagram_carousel",
      "instagram_caption",
      "medium_adaptation",
    ]),
    status: z.enum([
      "draft",
      "approved",
      "scheduled",
      "rejected",
      "changes_requested",
      "posted_manually",
      "posted",
      "cancelled",
    ]),
    text: z.string().max(20000).optional(),
    title: z.string().max(200).optional(),
    slides: z.array(carouselSlideSchema).optional(),
    thread: z.array(z.string().min(1).max(1000)).optional(),
    hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).max(30),
    link: z.string().url().optional(),
    altText: z.string().max(1000).optional(),
    visualBrief: visualBriefSchema.optional(),
    assetIds: z.array(opaque("socialasset")).optional(),
    suggestedPublishAt: iso.optional(),
    timezone: z.string().max(100).optional(),
    characterCount: z.number().int().nonnegative(),
    claimReferences: z.array(z.string().regex(/^pubclaim_[a-f0-9]{16}$/)),
    sourcePublicationHash: hash,
    warnings: z.array(z.string().max(500)),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict();
export type PlatformContentItem = z.infer<typeof platformContentItemSchema>;
export const importedSocialResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    publicationId: opaque("publication"),
    articleContentHash: hash,
    packageVersion: z.number().int().positive(),
    platforms: z.array(socialPlatformSchema).min(1),
    items: z
      .array(
        platformContentItemSchema.omit({
          id: true,
          status: true,
          characterCount: true,
          warnings: true,
          createdAt: true,
          updatedAt: true,
        }),
      )
      .min(1),
    visualBriefs: z.array(visualBriefSchema),
    imagePrompts: z.array(imagePromptSchema),
    timingSuggestions: z.array(
      z
        .object({
          platform: socialPlatformSchema,
          publishAt: iso,
          timezone: z.string(),
        })
        .strict(),
    ),
    disclosures: z.array(socialDisclosureSchema),
    generatorNotes: z.array(z.string().max(1000)),
    unresolvedQuestions: z.array(z.string().max(1000)),
    provenance: z
      .object({ mode: socialGenerationModeSchema, taskHash: hash })
      .strict(),
  })
  .strict();
export type ImportedSocialResult = z.infer<typeof importedSocialResultSchema>;
export const socialPackageSchema = z
  .object({
    id: opaque("socialpackage"),
    publicationId: opaque("publication"),
    topicId: z.string(),
    articleSlug: z.string(),
    articleTitle: z.string(),
    canonicalUrl: z.string().url(),
    articleContentHash: hash,
    version: z.number().int().positive(),
    status: z.enum([
      "awaiting_generation",
      "imported",
      "validated",
      "partially_approved",
      "approved",
      "scheduled",
      "rejected",
      "superseded",
      "cancelled",
    ]),
    generationMode: socialGenerationModeSchema,
    platforms: z.array(socialPlatformSchema),
    items: z.array(platformContentItemSchema),
    createdAt: iso,
    updatedAt: iso,
    supersedesVersion: z.number().int().positive().optional(),
    provenance: z
      .object({
        taskHash: hash,
        importHash: hash,
        importedAt: iso,
        importedBy: z.literal("manual"),
      })
      .strict(),
    warnings: z.array(z.string().max(500)),
    disclosures: z.array(socialDisclosureSchema),
  })
  .strict();
export type SocialPackage = z.infer<typeof socialPackageSchema>;

export const socialDistributionPlatformStateSchema = z
  .object({
    platform: socialPlatformSchema,
    state: z.enum([
      "selected",
      "prepared",
      "approved",
      "manual_ready",
      "posted",
      "blocked",
      "failed",
    ]),
    provider: z.string().min(1).max(100),
    capabilities: socialPublisherCapabilitiesSchema,
    itemIds: z.array(opaque("socialitem")),
    assetIds: z.array(opaque("socialasset")),
    warnings: z.array(z.string().max(500)),
    error: z.string().max(1000).optional(),
    postUrl: z.string().url().optional(),
  })
  .strict();
export const socialDistributionPlanSchema = z
  .object({
    id: opaque("socialplan"),
    publicationId: opaque("publication"),
    articleContentHash: hash,
    articleTitle: z.string().min(1).max(300),
    canonicalUrl: z.string().url(),
    status: z.enum([
      "selecting",
      "preparing",
      "ready_for_confirmation",
      "approved",
      "manual_ready",
      "completed",
      "blocked",
      "failed",
      "cancelled",
      "skipped",
    ]),
    selectedPlatforms: z.array(socialPlatformSchema).max(4),
    platformStates: z.array(socialDistributionPlatformStateSchema).max(4),
    packageId: opaque("socialpackage").optional(),
    packageVersion: z.number().int().positive().optional(),
    selectionRevision: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    createdAt: iso,
    updatedAt: iso,
    confirmedAt: iso.optional(),
  })
  .strict();
export type SocialDistributionPlan = z.infer<
  typeof socialDistributionPlanSchema
>;

export const socialDistributionEventSchema = z
  .object({
    id: opaque("socialevent"),
    planId: opaque("socialplan"),
    sequence: z.number().int().positive(),
    type: z.enum([
      "created",
      "platform_toggled",
      "preparation_started",
      "regenerated",
      "prepared",
      "confirmed",
      "manual_ready",
      "posted",
      "failed",
      "cancelled",
      "skipped",
    ]),
    platform: socialPlatformSchema.optional(),
    telegramUpdateId: z.number().int().nonnegative().optional(),
    callbackQueryId: z.string().max(256).optional(),
    actorUserId: z.string().regex(/^\d+$/).optional(),
    planVersion: z.number().int().positive(),
    selectedPlatforms: z.array(socialPlatformSchema).max(4),
    planStatus: socialDistributionPlanSchema.shape.status,
    snapshotHash: hash,
    createdAt: iso,
  })
  .strict();
export type SocialDistributionEvent = z.infer<
  typeof socialDistributionEventSchema
>;

export const socialAssetSchema = z
  .object({
    id: opaque("socialasset"),
    planId: opaque("socialplan"),
    publicationId: opaque("publication"),
    packageId: opaque("socialpackage"),
    packageVersion: z.number().int().positive(),
    platform: socialPlatformSchema,
    kind: z.enum([
      "social_card",
      "carousel_slide",
      "medium_inline",
      "approved_hero",
    ]),
    format: z.literal("png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    slideNumber: z.number().int().positive().optional(),
    path: z.string().min(1),
    contentHash: hash,
    altText: z.string().min(1).max(1000),
    createdAt: iso,
  })
  .strict();
export type SocialAsset = z.infer<typeof socialAssetSchema>;

export const socialQualitySchema = z
  .object({
    packageId: opaque("socialpackage"),
    packageVersion: z.number().int().positive(),
    platformItemId: opaque("socialitem"),
    platform: socialPlatformSchema,
    characterCount: z.number().int().nonnegative(),
    wordCount: z.number().int().nonnegative(),
    claimAlignment: z.enum(["aligned", "warning", "blocked"]),
    linkValid: z.boolean(),
    hookWarnings: z.array(z.string()),
    repetition: z.array(z.string()),
    platformFit: z.array(z.string()),
    disclosureCompliance: z.array(z.string()),
    hashtagCount: z.number().int().nonnegative(),
    emojiCount: z.number().int().nonnegative(),
    copySimilarity: z.number().min(0).max(1),
    timingValid: z.boolean(),
    visualRisk: z.array(z.string()),
    blockingIssues: z.array(z.string()),
    warnings: z.array(z.string()),
    status: z.enum(["passed", "passed_with_warnings", "blocked"]),
    createdAt: iso,
  })
  .strict();
export type SocialQuality = z.infer<typeof socialQualitySchema>;
export const socialApprovalSchema = z
  .object({
    id: opaque("socialapproval"),
    packageId: opaque("socialpackage"),
    packageVersion: z.number().int().positive(),
    platformItemId: opaque("socialitem"),
    platform: socialPlatformSchema,
    action: z.enum([
      "approve",
      "schedule",
      "request_changes",
      "reject",
      "hold",
      "mark_posted",
    ]),
    status: z.enum([
      "approved",
      "scheduled",
      "changes_requested",
      "rejected",
      "held",
      "posted_manually",
      "posted",
    ]),
    approvalNotes: z.array(z.string().max(1000)),
    requestedChanges: z.array(z.string().max(1000)),
    scheduledAt: iso.optional(),
    createdAt: iso,
    updatedAt: iso,
    telegramUpdateId: z.number().int().nonnegative(),
    telegramMessageId: z.number().int().nonnegative().optional(),
    callbackQueryId: z.string().max(256).optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type SocialApproval = z.infer<typeof socialApprovalSchema>;
export const socialExportSchema = z
  .object({
    id: opaque("socialexport"),
    packageId: opaque("socialpackage"),
    packageVersion: z.number().int().positive(),
    platform: socialPlatformSchema,
    format: z.enum(["text", "markdown", "json"]),
    path: z.string(),
    contentHash: hash,
    createdAt: iso,
  })
  .strict();
export type SocialExport = z.infer<typeof socialExportSchema>;
export const socialHistorySchema = z
  .object({
    publicationId: opaque("publication"),
    platform: socialPlatformSchema,
    hook: z.string().max(300),
    mainAngle: z.string().max(500),
    entities: z.array(z.string()),
    keywords: z.array(z.string()),
    contentHash: hash,
    approvedDate: iso.optional(),
    scheduledDate: iso.optional(),
    postedDate: iso.optional(),
    status: z.enum([
      "approved",
      "scheduled",
      "posted_manually",
      "posted",
      "rejected",
    ]),
    postUrl: z.string().url().optional(),
  })
  .strict();
export type SocialHistory = z.infer<typeof socialHistorySchema>;
export const socialRevisionSchema = z
  .object({
    publicationId: opaque("publication"),
    sourcePackageVersion: z.number().int().positive(),
    scope: z.enum([
      "linkedin_only",
      "x_post_only",
      "x_thread_only",
      "instagram_carousel_only",
      "instagram_caption_only",
      "medium_only",
      "timing_only",
      "visual_brief_only",
      "full_package",
    ]),
    instruction: z.string().min(1).max(2000),
    protectedClaimIds: z.array(z.string().regex(/^pubclaim_[a-f0-9]{16}$/)),
    createdAt: iso,
    taskHash: hash,
  })
  .strict();
export type SocialRevision = z.infer<typeof socialRevisionSchema>;
export const socialConversationSchema = z
  .object({
    chatId: z.string().regex(/^-?\d+$/),
    userId: z.string().regex(/^\d+$/),
    publicationId: opaque("publication"),
    packageVersion: z.number().int().positive(),
    platformItemId: opaque("socialitem"),
    platform: socialPlatformSchema,
    state: z.enum([
      "awaiting_social_change_request",
      "awaiting_social_schedule_time",
      "awaiting_social_rejection_reason",
      "awaiting_social_approval_note",
      "awaiting_social_post_url",
    ]),
    createdAt: iso,
    expiresAt: iso,
  })
  .strict();
export type SocialConversation = z.infer<typeof socialConversationSchema>;
export const postedRecordSchema = z
  .object({
    publicationId: opaque("publication"),
    packageId: opaque("socialpackage"),
    packageVersion: z.number().int().positive(),
    platform: socialPlatformSchema,
    platformItemId: opaque("socialitem"),
    postUrl: z.string().url(),
    postedAt: iso,
    method: z.enum(["manual", "api"]),
    provider: z.string().min(1).max(100).optional(),
    contentHash: hash,
    verificationState: z.enum([
      "operator_confirmed",
      "api_confirmed",
      "unverified",
    ]),
  })
  .strict();
export type PostedRecord = z.infer<typeof postedRecordSchema>;
