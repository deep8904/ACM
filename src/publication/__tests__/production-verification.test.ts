import { describe, expect, it } from "vitest";

import { publicationConfigSchema } from "../config";
import type {
  ContentRepository,
  DeploymentProvider,
  PublicationRepository,
} from "../interfaces";
import {
  deploymentRecordSchema,
  publicationRecordSchema,
  type DirectProductionPublicationArtifact,
} from "../models";
import {
  DirectProductionVerificationService,
  type DirectProductionArtifactRepository,
} from "../production-verification";
import { digest } from "../transform";

const now = "2026-08-10T00:00:00.000Z";
const publicationId = `publication_${"a".repeat(24)}`;
const eventId = `articleevent_${"b".repeat(24)}`;
const content = `---\ncanonicalUrl: "https://example.com/blog/verified"\n---\n\n# Verified\n`;

function harness(overrides: { content?: string; ancestor?: boolean } = {}) {
  const publication = publicationRecordSchema.parse({
    id: publicationId,
    topicId: "topic_verified",
    draftId: `draft_${"c".repeat(24)}`,
    draftVersion: 1,
    reviewId: `review_${"d".repeat(24)}`,
    reviewVersion: 1,
    researchPacketId: `packet_${"e".repeat(24)}`,
    researchPacketVersion: 1,
    finalApprovedEventId: eventId,
    status: "published",
    title: "Verified direct publication",
    slug: "verified",
    articlePath: "content/blog/2026/verified.mdx",
    repository: "owner/blog",
    branch: "main",
    commitSha: "1".repeat(40),
    deploymentProvider: "vercel_git",
    deploymentId: "deployment",
    canonicalUrl: "https://example.com/blog/verified",
    publishedAt: now,
    sourceCount: 1,
    contentHash: digest(content),
    approvedSnapshotHash: "2".repeat(64),
    publishedSnapshotHash: "3".repeat(64),
    createdAt: now,
    updatedAt: now,
    warnings: [],
    provenance: { mode: "github", parentSha: "0".repeat(40) },
    version: 1,
  });
  const publications: PublicationRepository = {
    getByEvent: async () => publication,
    getByTopic: async () => publication,
    save: async () => undefined,
    list: async () => [publication],
  };
  let saved: DirectProductionPublicationArtifact | undefined;
  const artifacts: DirectProductionArtifactRepository = {
    getById: async () => saved,
    save: async (value) => {
      saved = value;
    },
  };
  const repository: ContentRepository = {
    getDefaultBranch: async () => "main",
    getFile: async () => ({
      path: publication.articlePath,
      content: overrides.content ?? content,
      sha: "4".repeat(40),
    }),
    findCaseInsensitiveFile: async () => null,
    createBranch: async () => undefined,
    createCommit: async () => {
      throw new Error("unused");
    },
    createCommitOnNewBranch: async () => {
      throw new Error("unused");
    },
    updateRef: async () => undefined,
    getCommit: async (value) => ({
      sha: value === "main" ? "4".repeat(40) : publication.commitSha,
      parentSha: "0".repeat(40),
      branch: "main",
    }),
    isAncestor: async () => overrides.ancestor ?? true,
  };
  const deployment: DeploymentProvider = {
    waitForDeployment: async () => {
      throw new Error("unused");
    },
    getDeploymentStatus: async ({ commitSha }) =>
      deploymentRecordSchema.parse({
        publicationId,
        provider: "vercel_git",
        commitSha,
        status: "ready",
        deploymentId: "deployment",
        environment: "production",
        checkedAt: now,
        version: 1,
      }),
  };
  const config = publicationConfigSchema.parse({
    mode: "github",
    repository: "owner/blog",
    defaultBranch: "main",
    branchStrategy: "direct",
    contentRoot: "content/blog",
    pathPattern: "content/blog/{year}/{slug}.mdx",
    siteOrigin: "https://example.com",
    blogRoutePrefix: "/blog",
    citationStyle: "numbered_footnotes",
    commitMessagePattern: "publish: {title}",
    deploymentProvider: "vercel_git",
    deploymentPolicy: "required",
    deploymentTimeoutSeconds: 60,
    pollIntervalSeconds: 2,
    publicPageVerification: true,
    maximumAttempts: 3,
    scheduledGraceMinutes: 60,
    claimTimeoutMinutes: 30,
    notifications: true,
  });
  return new DirectProductionVerificationService({
    publications,
    artifacts,
    repository,
    deployment,
    config,
    clock: () => new Date(now),
  });
}

describe("direct production verification", () => {
  it("persists exact ancestry, production hash, canonical, and deployment evidence", async () => {
    const result = await harness().verify(publicationId);
    expect(result.artifact.verificationMethods).toHaveLength(5);
    expect(result.artifact.productionCommitSha).toBe("4".repeat(40));
  });

  it("rejects a production content mismatch", async () => {
    await expect(
      harness({ content: `${content}\nchanged` }).verify(publicationId),
    ).rejects.toThrow("content hash mismatch");
  });
});
