import { sha256 } from "../../writing/task";
import {
  productionPublicationArtifactSchema,
  type ProductionPublicationArtifact,
  type PublicationRecord,
} from "../models";

export function productionArtifactFixture(
  source: PublicationRecord,
  overrides: Partial<ProductionPublicationArtifact> = {},
) {
  const sourcePublicationId = `publication_${sha256(`source:${source.id}`).slice(0, 24)}`;
  const republishId = `republish_${sha256(`republish:${source.id}`).slice(0, 24)}`;
  return productionPublicationArtifactSchema.parse({
    ...source,
    sourcePublicationId,
    republishId,
    baseBranch: "main",
    republishBranch: `republish/${source.slug}`,
    republishCommitSha: source.commitSha,
    productionCommitSha: source.commitSha,
    republishCommitIsAncestor: true,
    deploymentProvider: "vercel_git",
    deploymentStatus: "ready",
    deploymentEnvironment: "production",
    expectedContentHash: source.contentHash,
    verifiedAt: source.updatedAt,
    verificationMethods: [
      "repository_commit",
      "commit_ancestry",
      "production_blob_hash",
      "canonical_frontmatter",
      "production_deployment",
    ],
    idempotencyKey: sha256(`production:${source.id}`),
    provenance: {
      mode: "github_republish_verified",
      sourceMode: "fixture",
      sourcePublicationId,
      republishId,
      sourceFinalApprovedEventId: source.finalApprovedEventId,
      sourceApprovedSnapshotHash: source.approvedSnapshotHash,
      sourcePublishedSnapshotHash: source.publishedSnapshotHash,
      version: 1,
    },
    ...overrides,
  });
}
