import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const gitCommitShaSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const opaque = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{24}$`));

export const publicationJobSchema = z
  .object({
    id: opaque("publicationjob"),
    finalApprovedEventId: opaque("articleevent"),
    topicId: z.string(),
    draftId: opaque("draft"),
    draftVersion: z.number().int().positive(),
    reviewId: opaque("review"),
    reviewVersion: z.number().int().positive(),
    attempt: z.number().int().positive(),
    status: z.enum([
      "pending",
      "claimed",
      "validating",
      "rendering",
      "writing_repository",
      "waiting_for_deployment",
      "verifying_deployment",
      "completed",
      "failed",
      "cancelled",
      "blocked",
    ]),
    startedAt: iso,
    heartbeatAt: iso,
    completedAt: iso.optional(),
    failedAt: iso.optional(),
    failureCode: z.string().max(100).optional(),
    failureMessage: z.string().max(1000).optional(),
    publicationId: opaque("publication").optional(),
    workerId: z.string().min(1).max(200),
    version: z.number().int().positive(),
  })
  .strict();
export type PublicationJob = z.infer<typeof publicationJobSchema>;

export const sourceReferenceSchema = z
  .object({
    id: z.string().regex(/^ref_[a-f0-9]{16}$/),
    label: z.string().min(1).max(200),
    publisher: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    url: z.string().url(),
    publishedAt: iso.optional(),
    isPrimary: z.boolean(),
    accessedAt: iso,
    type: z.string().min(1).max(80),
  })
  .strict();
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const publishedArticleSnapshotSchema = z
  .object({
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    category: z.string(),
    tags: z.array(z.string()),
    author: z.literal("Deep"),
    articleType: z.string(),
    publishedAt: iso,
    updatedAt: iso,
    canonicalUrl: z.string().url(),
    heroImage: z.null(),
    heroAlt: z.string(),
    sourceDisclosure: z.string(),
    sources: z.array(sourceReferenceSchema),
    mdx: z.string(),
    contentHash: hash,
  })
  .strict();
export type PublishedArticleSnapshot = z.infer<
  typeof publishedArticleSnapshotSchema
>;

export const publicationRecordSchema = z
  .object({
    id: opaque("publication"),
    topicId: z.string(),
    draftId: opaque("draft"),
    draftVersion: z.number().int().positive(),
    reviewId: opaque("review"),
    reviewVersion: z.number().int().positive(),
    researchPacketId: opaque("packet"),
    researchPacketVersion: z.number().int().positive(),
    finalApprovedEventId: opaque("articleevent"),
    status: z.enum([
      "preparing",
      "committed",
      "deploying",
      "published",
      "deployment_failed",
      "verification_required",
      "cancelled",
      "superseded",
    ]),
    title: z.string(),
    slug: z.string(),
    articlePath: z.string(),
    repository: z.string(),
    branch: z.string(),
    commitSha: gitCommitShaSchema,
    commitUrl: z.string().url().optional(),
    deploymentProvider: z.enum(["mock", "vercel_git", "manual"]),
    deploymentId: z.string().optional(),
    deploymentUrl: z.string().url().optional(),
    canonicalUrl: z.string().url(),
    publishedAt: iso,
    scheduledFor: iso.optional(),
    sourceCount: z.number().int().nonnegative(),
    contentHash: hash,
    approvedSnapshotHash: hash,
    publishedSnapshotHash: hash,
    createdAt: iso,
    updatedAt: iso,
    warnings: z.array(z.string().max(500)),
    provenance: z
      .object({
        mode: z.enum(["fixture", "github"]),
        parentSha: gitCommitShaSchema,
      })
      .strict(),
    version: z.number().int().positive(),
  })
  .strict();
export type PublicationRecord = z.infer<typeof publicationRecordSchema>;

export const publicationRepublishRecordSchema = z
  .object({
    id: opaque("republish"),
    sourcePublicationId: opaque("publication"),
    sourceFinalApprovedEventId: opaque("articleevent"),
    status: z.enum(["committed", "verification_required"]),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1),
    branch: z.string().min(1),
    articlePath: z.string().min(1),
    commitSha: gitCommitShaSchema,
    commitUrl: z.string().url().optional(),
    canonicalUrl: z.string().url(),
    sourceCanonicalUrl: z.string().url(),
    sourceContentHash: hash,
    targetContentHash: hash,
    approvedSnapshotHash: hash,
    sourcePublishedSnapshotHash: hash,
    idempotencyKey: hash,
    createdAt: iso,
    provenance: z
      .object({
        mode: z.literal("github_republish"),
        sourceMode: z.literal("fixture"),
        sourcePublicationId: opaque("publication"),
        transformation: z.literal("canonical_url_only"),
        parentSha: gitCommitShaSchema,
      })
      .strict(),
    version: z.literal(1),
  })
  .strict();
export type PublicationRepublishRecord = z.infer<
  typeof publicationRepublishRecordSchema
>;

export const legacyProductionPublicationArtifactSchema = publicationRecordSchema
  .omit({ provenance: true })
  .extend({
    sourcePublicationId: opaque("publication"),
    republishId: opaque("republish"),
    status: z.literal("published"),
    baseBranch: z.string().min(1),
    republishBranch: z.string().min(1),
    republishCommitSha: gitCommitShaSchema,
    productionCommitSha: gitCommitShaSchema,
    republishCommitIsAncestor: z.literal(true),
    expectedContentHash: hash,
    deploymentStatus: z.literal("ready"),
    deploymentEnvironment: z.literal("production"),
    verifiedAt: iso,
    verificationMethods: z
      .array(
        z.enum([
          "repository_commit",
          "commit_ancestry",
          "production_blob_hash",
          "canonical_frontmatter",
          "production_deployment",
          "operator_visual_acknowledgement",
        ]),
      )
      .min(5),
    operatorAcknowledgement: z
      .object({
        acknowledged: z.literal(true),
        acknowledgedAt: iso,
        scope: z
          .array(
            z.enum([
              "production_rendering",
              "writing_listing",
              "formatting",
              "references",
              "mobile_layout",
            ]),
          )
          .min(1),
      })
      .strict()
      .optional(),
    idempotencyKey: hash,
    provenance: z
      .object({
        mode: z.literal("github_republish_verified"),
        sourceMode: z.literal("fixture"),
        sourcePublicationId: opaque("publication"),
        republishId: opaque("republish"),
        sourceFinalApprovedEventId: opaque("articleevent"),
        sourceApprovedSnapshotHash: hash,
        sourcePublishedSnapshotHash: hash,
        version: z.literal(1),
      })
      .strict(),
  })
  .superRefine((value, context) => {
    if (value.commitSha !== value.productionCommitSha)
      context.addIssue({
        code: "custom",
        path: ["commitSha"],
        message: "Production commit fields must match",
      });
    if (value.contentHash !== value.expectedContentHash)
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "Production content hashes must match",
      });
    if (
      value.finalApprovedEventId !== value.provenance.sourceFinalApprovedEventId
    )
      context.addIssue({
        code: "custom",
        path: ["finalApprovedEventId"],
        message: "Approval lineage must match",
      });
  });
export type LegacyProductionPublicationArtifact = z.infer<
  typeof legacyProductionPublicationArtifactSchema
>;

export const directProductionPublicationArtifactSchema = publicationRecordSchema
  .extend({
    sourcePublicationId: opaque("publication"),
    status: z.literal("published"),
    baseBranch: z.string().min(1),
    productionCommitSha: gitCommitShaSchema,
    expectedContentHash: hash,
    deploymentStatus: z.literal("ready"),
    deploymentEnvironment: z.literal("production"),
    verifiedAt: iso,
    verificationMethods: z
      .array(
        z.enum([
          "repository_commit",
          "commit_ancestry",
          "production_blob_hash",
          "canonical_frontmatter",
          "production_deployment",
        ]),
      )
      .length(5),
    idempotencyKey: hash,
    provenance: z
      .object({
        mode: z.literal("github_direct_verified"),
        sourcePublicationId: opaque("publication"),
        sourceFinalApprovedEventId: opaque("articleevent"),
        sourceApprovedSnapshotHash: hash,
        sourcePublishedSnapshotHash: hash,
        version: z.literal(1),
      })
      .strict(),
  })
  .superRefine((value, context) => {
    if (
      value.id !== value.sourcePublicationId ||
      value.commitSha !== value.productionCommitSha ||
      value.contentHash !== value.expectedContentHash ||
      value.finalApprovedEventId !== value.provenance.sourceFinalApprovedEventId
    )
      context.addIssue({
        code: "custom",
        message:
          "Direct production artifact lineage must match the source publication",
      });
  });

export const productionPublicationArtifactSchema =
  legacyProductionPublicationArtifactSchema;
export type DirectProductionPublicationArtifact = z.infer<
  typeof directProductionPublicationArtifactSchema
>;
/** Backward-compatible name for the immutable fixture-republish artifact. */
export type ProductionPublicationArtifact = LegacyProductionPublicationArtifact;

export const deploymentRecordSchema = z
  .object({
    publicationId: opaque("publication"),
    provider: z.enum(["mock", "vercel_git", "manual"]),
    commitSha: gitCommitShaSchema,
    status: z.enum(["pending", "ready", "failed", "verification_required"]),
    deploymentId: z.string().optional(),
    url: z.string().url().optional(),
    environment: z.enum(["production", "preview", "unknown"]),
    checkedAt: iso,
    message: z.string().max(500).optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>;

export const publicationVerificationSchema = z
  .object({
    publicationId: opaque("publication"),
    status: z.enum(["verified", "failed"]),
    urlLoads: z.boolean(),
    correctTitle: z.boolean(),
    correctContent: z.boolean(),
    correctCanonicalUrl: z.boolean(),
    formattingOk: z.boolean(),
    sourcesRender: z.boolean(),
    noDraftBadge: z.boolean(),
    mobileReadable: z.boolean(),
    verifiedAt: iso,
    verifier: z.enum(["fixture", "manual", "http"]),
    importHash: hash.optional(),
    notes: z.array(z.string().max(500)),
  })
  .strict();
export type PublicationVerification = z.infer<
  typeof publicationVerificationSchema
>;

export const consumptionRecordSchema = z
  .object({
    finalApprovedEventId: opaque("articleevent"),
    consumerId: z.string(),
    publicationId: opaque("publication"),
    commitSha: gitCommitShaSchema,
    deploymentId: z.string().optional(),
    verificationState: z.enum(["verified", "best_effort"]),
    consumedAt: iso,
    snapshotHash: hash,
  })
  .strict();
export type ConsumptionRecord = z.infer<typeof consumptionRecordSchema>;
