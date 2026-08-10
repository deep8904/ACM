import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const confidence = z.number().min(0).max(1);

export const selectedExcerptSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  locator: z.string().min(1).max(300),
  purpose: z.string().min(1).max(200),
});

export const researchSourceSchema = z
  .object({
    id: z.string().regex(/^source_[a-f0-9]{24}$/),
    topicId: z.string().min(1),
    sourceItemId: z.string().min(1).optional(),
    originalUrl: z.string().url(),
    canonicalUrl: z.string().url(),
    finalUrl: z.string().url(),
    title: z.string().min(1),
    publisher: z.string().min(1),
    publisherGroup: z.string().min(1),
    publisherOwner: z.string().min(1).optional(),
    sourceType: z.enum([
      "official_announcement",
      "documentation",
      "release_notes",
      "repository",
      "technical_reporting",
      "general_reporting",
      "community_discussion",
      "product_page",
      "support_document",
      "regulatory_filing",
      "research_paper",
      "manual_url",
      "other",
    ]),
    authority: z.enum(["primary", "independent", "community", "aggregator"]),
    isPrimary: z.boolean(),
    author: z.string().optional(),
    publishedAt: iso.optional(),
    retrievedAt: iso,
    contentType: z.string(),
    language: z.string().min(2),
    contentHash: hash,
    extractionMethod: z.enum([
      "html",
      "text",
      "json",
      "xml",
      "metadata",
      "cache",
    ]),
    extractionStatus: z.enum([
      "pending",
      "extracted",
      "metadata_only",
      "blocked",
      "failed",
      "unsupported",
    ]),
    extractionQuality: z.enum([
      "high",
      "medium",
      "low",
      "metadata_only",
      "failed",
    ]),
    qualityMetrics: z
      .object({
        wordCount: z.number().int().nonnegative(),
        paragraphCount: z.number().int().nonnegative(),
        headingCount: z.number().int().nonnegative(),
        metadataFields: z.number().int().nonnegative(),
      })
      .strict(),
    wordCount: z.number().int().nonnegative(),
    summary: z.string(),
    selectedExcerpts: z.array(selectedExcerptSchema).max(8),
    licenseNotes: z.string(),
    warnings: z.array(z.string()),
    rawMetadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const evidenceClaimSchema = z
  .object({
    id: z.string().regex(/^claim_[a-f0-9]{24}$/),
    topicId: z.string().min(1),
    statement: z.string().min(1),
    normalizedStatement: z.string().min(1),
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
    sourceIds: z.array(z.string()).min(1),
    supportingExcerptIds: z.array(z.string()),
    confidence,
    status: z.enum([
      "supported",
      "partially_supported",
      "conflicting",
      "unsupported",
      "unverified",
    ]),
    disagreementSourceIds: z.array(z.string()),
    notes: z.array(z.string()),
    createdAt: iso,
  })
  .strict();
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

export const timelineEventSchema = z
  .object({
    id: z.string().regex(/^timeline_[a-f0-9]{24}$/),
    occurredAt: iso,
    precision: z.enum(["day", "month", "year", "unknown"]),
    event: z.string().min(1),
    sourceIds: z.array(z.string()).min(1),
    confidence,
  })
  .strict();

export const researchConflictSchema = z
  .object({
    id: z.string().min(1),
    subject: z.string().min(1),
    statements: z
      .array(
        z.object({
          statement: z.string(),
          sourceIds: z.array(z.string()).min(1),
        }),
      )
      .min(2),
    severity: z.enum(["warning", "blocking"]),
    resolution: z.string().optional(),
  })
  .strict();

export const sufficiencySchema = z
  .object({
    score: z.number().min(0).max(100),
    threshold: z.number().min(0).max(100),
    components: z.object({
      primarySources: z.number(),
      sourceDiversity: z.number(),
      extractionQuality: z.number(),
      claimCoverage: z.number(),
      recency: z.number(),
      scope: z.number(),
    }),
    penalties: z.object({
      conflicts: z.number(),
      unknowns: z.number(),
      weakSources: z.number(),
    }),
    explanation: z.array(z.string()),
  })
  .strict();

export const researchPacketSchema = z
  .object({
    id: z.string().regex(/^packet_[a-f0-9]{24}$/),
    version: z.number().int().positive(),
    topicId: z.string(),
    candidateId: z.string(),
    runId: z.string(),
    approvedEventId: z.string(),
    origin: z.enum(["ranked", "manual_topic", "manual_url"]),
    approvedTitle: z.string(),
    approvedAngle: z.string(),
    editorialNotes: z.array(z.string()),
    createdAt: iso,
    updatedAt: iso,
    status: z.enum([
      "collecting",
      "awaiting_assisted_synthesis",
      "ready",
      "insufficient",
      "failed",
      "superseded",
    ]),
    researchMode: z.enum(["deterministic", "assisted_import"]),
    scope: z.array(z.string()),
    executiveSummary: z.string(),
    timeline: z.array(timelineEventSchema),
    facts: z.array(evidenceClaimSchema),
    interpretations: z.array(evidenceClaimSchema),
    predictions: z.array(evidenceClaimSchema),
    communityObservations: z.array(evidenceClaimSchema),
    technicalDetails: z.array(z.string()),
    productSpecifications: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        sourceIds: z.array(z.string()).min(1),
      }),
    ),
    counterpoints: z.array(z.string()),
    conflicts: z.array(researchConflictSchema),
    unknowns: z.array(z.string()),
    sourceIndex: z.array(researchSourceSchema),
    primarySourceIds: z.array(z.string()),
    recommendedThesis: z.string(),
    recommendedArticleType: z.enum([
      "news_analysis",
      "explainer",
      "comparison",
      "technical_deep_dive",
      "opinion",
      "unknown",
    ]),
    recommendedStructure: z.array(z.string()),
    researchConfidence: confidence,
    researchSufficiency: sufficiencySchema,
    sufficient: z.boolean(),
    blockingReasons: z.array(z.string()),
    warnings: z.array(z.string()),
    contentHashes: z.array(hash),
    provenance: z.object({
      deterministic: z.boolean(),
      importedAt: iso.optional(),
      importedBy: z.string().optional(),
      promptVersion: z.string(),
      sourcePacketVersion: z.number().int().positive().optional(),
      importHash: hash.optional(),
      extensionHash: hash.optional(),
      extension: z
        .object({
          kind: z.literal("source_extension"),
          canonicalUrl: z.string().url(),
          sourceId: z.string(),
          authority: researchSourceSchema.shape.authority,
          sourceType: researchSourceSchema.shape.sourceType,
          publisher: z.string().min(1),
          publisherOwner: z.string().min(1),
        })
        .strict()
        .optional(),
    }),
  })
  .strict();
export type ResearchPacket = z.infer<typeof researchPacketSchema>;

export const researchJobSchema = z
  .object({
    id: z.string().regex(/^job_[a-f0-9]{24}$/),
    eventId: z.string(),
    topicId: z.string(),
    status: z.enum([
      "claimed",
      "resolving",
      "retrieving",
      "extracting",
      "analyzing",
      "persisting",
      "awaiting_assistance",
      "completed",
      "failed",
      "cancelled",
      "superseded",
    ]),
    attempt: z.number().int().positive(),
    claimedAt: iso,
    heartbeatAt: iso,
    completedAt: iso.optional(),
    workerId: z.string(),
    retries: z.array(
      z.object({
        attempt: z.number().int().positive(),
        at: iso,
        reason: z.string(),
      }),
    ),
    errors: z.array(z.string()),
    packetId: z.string().optional(),
    packetVersion: z.number().int().positive().optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type ResearchJob = z.infer<typeof researchJobSchema>;

export const assistedResearchResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    topicId: z.string(),
    approvedEventId: z.string(),
    sourcePacketVersion: z.number().int().positive(),
    executiveSummary: z.string().min(1).max(4000),
    interpretations: z.array(evidenceClaimSchema),
    predictions: z.array(evidenceClaimSchema),
    counterpoints: z.array(z.string().max(1000)),
    unknowns: z.array(z.string().max(1000)),
    recommendedThesis: z.string().max(2000),
    recommendedArticleType: z.enum([
      "news_analysis",
      "explainer",
      "comparison",
      "technical_deep_dive",
      "opinion",
      "unknown",
    ]),
    recommendedStructure: z.array(z.string().max(500)),
  })
  .strict();
export type AssistedResearchResult = z.infer<
  typeof assistedResearchResultSchema
>;
