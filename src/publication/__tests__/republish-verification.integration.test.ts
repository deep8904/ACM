import { describe, expect, it } from "vitest";
import { publicationConfigSchema } from "../config";
import type {
  ContentRepository,
  ProductionPublicationArtifactRepository,
  RepositoryCommit,
} from "../interfaces";
import {
  deploymentRecordSchema,
  gitCommitShaSchema,
  publicationRecordSchema,
  publicationRepublishRecordSchema,
  type ProductionPublicationArtifact,
} from "../models";
import {
  PublicationRepublishVerificationService,
  assertCanonicalFrontmatter,
} from "../republish-verification";
import { digest } from "../transform";

const now = "2026-08-09T20:00:00.000Z";
const sourceId = "publication_78b30f88ad9d7399fee7502b";
const republishId = "republish_0eeea877c1b7d6fce9d614c9";
const eventId = "articleevent_022b92dda60924fe224e4392";
const path = "content/blog/2026/verified.mdx";
const canonical = "https://production.example/blog/verified";
const sourceCanonical = "https://fixture.example/blog/verified";
const republishCommit = "c".repeat(40);
const productionCommit = "d".repeat(40);
const content = `---\ntitle: "Verified"\ncanonicalUrl: "${canonical}"\n---\n\nProduction body.\n`;

class MemoryArtifacts implements ProductionPublicationArtifactRepository {
  records: ProductionPublicationArtifact[] = [];
  async getById(id: string) {
    return this.records.find((value) => value.id === id);
  }
  async getByRepublishId(id: string) {
    return this.records.find((value) => value.republishId === id);
  }
  async save(value: ProductionPublicationArtifact) {
    if (!(await this.getByRepublishId(value.republishId)))
      this.records.push(value);
  }
  async list() {
    return this.records;
  }
}

class VerificationRepository implements ContentRepository {
  ancestor = true;
  body = content;
  articlePath = path;
  async getDefaultBranch() {
    return "main";
  }
  async getFile(value: string) {
    return value === this.articlePath
      ? { path: value, content: this.body, sha: "e".repeat(40) }
      : null;
  }
  async findCaseInsensitiveFile() {
    return null;
  }
  async createBranch() {}
  async createCommit(): Promise<RepositoryCommit> {
    throw new Error("not used");
  }
  async createCommitOnNewBranch(): Promise<RepositoryCommit> {
    throw new Error("not used");
  }
  async updateRef() {}
  async getCommit(value: string) {
    if (value === republishCommit)
      return {
        sha: republishCommit,
        parentSha: "a".repeat(40),
        branch: "republish/verified",
      };
    if (value === "main")
      return {
        sha: productionCommit,
        parentSha: republishCommit,
        branch: "main",
      };
    return null;
  }
  async isAncestor() {
    return this.ancestor;
  }
}

function harness() {
  const source = publicationRecordSchema.parse({
    id: sourceId,
    topicId: "topic_verified",
    draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
    draftVersion: 1,
    reviewId: "review_bbbbbbbbbbbbbbbbbbbbbbbb",
    reviewVersion: 1,
    researchPacketId: "packet_cccccccccccccccccccccccc",
    researchPacketVersion: 3,
    finalApprovedEventId: eventId,
    status: "published",
    title: "Verified",
    slug: "verified",
    articlePath: path,
    repository: "fixture/blog",
    branch: "main",
    commitSha: "a".repeat(64),
    deploymentProvider: "mock",
    canonicalUrl: sourceCanonical,
    publishedAt: now,
    sourceCount: 2,
    contentHash: "1".repeat(64),
    approvedSnapshotHash: "2".repeat(64),
    publishedSnapshotHash: "3".repeat(64),
    createdAt: now,
    updatedAt: now,
    warnings: [],
    provenance: { mode: "fixture", parentSha: "0".repeat(64) },
    version: 1,
  });
  const republish = publicationRepublishRecordSchema.parse({
    id: republishId,
    sourcePublicationId: source.id,
    sourceFinalApprovedEventId: source.finalApprovedEventId,
    status: "verification_required",
    repository: "owner/blog",
    baseBranch: "main",
    branch: "republish/verified",
    articlePath: path,
    commitSha: republishCommit,
    canonicalUrl: canonical,
    sourceCanonicalUrl: sourceCanonical,
    sourceContentHash: source.contentHash,
    targetContentHash: digest(content),
    approvedSnapshotHash: source.approvedSnapshotHash,
    sourcePublishedSnapshotHash: source.publishedSnapshotHash,
    idempotencyKey: "4".repeat(64),
    createdAt: now,
    provenance: {
      mode: "github_republish",
      sourceMode: "fixture",
      sourcePublicationId: source.id,
      transformation: "canonical_url_only",
      parentSha: "a".repeat(40),
    },
    version: 1,
  });
  const repository = new VerificationRepository();
  const artifacts = new MemoryArtifacts();
  let deploymentStatus: "ready" | "failed" = "ready";
  const service = new PublicationRepublishVerificationService({
    publications: {
      getByEvent: async () => source,
      getByTopic: async () => source,
      save: async () => undefined,
      list: async () => [source],
    },
    republishes: {
      getById: async (id) => (id === republish.id ? republish : undefined),
      getByIdempotencyKey: async () => republish,
      save: async () => undefined,
      list: async () => [republish],
    },
    productionArtifacts: artifacts,
    repository,
    deployment: {
      waitForDeployment: async () => {
        throw new Error("not used");
      },
      getDeploymentStatus: async ({ publicationId, commitSha }) =>
        deploymentRecordSchema.parse({
          publicationId,
          provider: "vercel_git",
          commitSha,
          status: deploymentStatus,
          deploymentId: "deployment-production",
          url: "https://deployment.example",
          environment: "production",
          checkedAt: now,
          version: 1,
        }),
    },
    config: publicationConfigSchema.parse({
      mode: "github",
      repository: "owner/blog",
      defaultBranch: "main",
      branchStrategy: "publication_branch",
      contentRoot: "content/blog",
      pathPattern: "content/blog/{year}/{slug}.mdx",
      siteOrigin: "https://production.example",
      blogRoutePrefix: "/blog",
      citationStyle: "numbered_footnotes",
      commitMessagePattern: "publish: {title}",
      deploymentProvider: "vercel_git",
      deploymentPolicy: "required",
      deploymentTimeoutSeconds: 60,
      pollIntervalSeconds: 1,
      publicPageVerification: true,
      maximumAttempts: 3,
      scheduledGraceMinutes: 60,
      claimTimeoutMinutes: 30,
      notifications: false,
    }),
    clock: () => new Date(now),
  });
  return {
    service,
    artifacts,
    repository,
    failDeployment: () => (deploymentStatus = "failed"),
  };
}

const request = {
  republishId,
  dryRun: false,
  manualVerificationAcknowledged: true,
};

describe("production republish verification", () => {
  it("persists one immutable production identity and reuses it", async () => {
    const h = harness();
    const first = await h.service.verify(request);
    const replay = await h.service.verify(request);
    expect(first.artifact).toMatchObject({
      republishId,
      sourcePublicationId: sourceId,
      republishCommitSha: republishCommit,
      productionCommitSha: productionCommit,
      contentHash: digest(content),
      canonicalUrl: canonical,
      deploymentProvider: "vercel_git",
      deploymentStatus: "ready",
    });
    expect(first.reused).toBe(false);
    expect(replay).toMatchObject({ reused: true, artifact: first.artifact });
    expect(h.artifacts.records).toHaveLength(1);
  });

  it("supports protected production pages through explicit visual acknowledgement", async () => {
    const h = harness();
    await expect(
      h.service.verify({ ...request, manualVerificationAcknowledged: false }),
    ).rejects.toThrow(/manual-verification-acknowledged/);
    expect(h.artifacts.records).toHaveLength(0);
    expect(
      (await h.service.verify(request)).artifact.operatorAcknowledgement,
    ).toMatchObject({ acknowledged: true });
  });

  it.each([
    [
      "non-ancestor commit",
      (h: ReturnType<typeof harness>) => (h.repository.ancestor = false),
      /ancestor/,
    ],
    [
      "wrong content hash",
      (h: ReturnType<typeof harness>) => (h.repository.body += "changed"),
      /content hash/,
    ],
    [
      "wrong path",
      (h: ReturnType<typeof harness>) =>
        (h.repository.articlePath = "content/other.mdx"),
      /path/,
    ],
    [
      "wrong canonical",
      (h: ReturnType<typeof harness>) =>
        (h.repository.body = h.repository.body.replace(
          canonical,
          "https://wrong.example",
        )),
      /content hash|canonical/,
    ],
    [
      "failed deployment",
      (h: ReturnType<typeof harness>) => h.failDeployment(),
      /not ready/,
    ],
  ])(
    "rejects %s without partial durable state",
    async (_name, mutate, message) => {
      const h = harness();
      mutate(h);
      await expect(h.service.verify(request)).rejects.toThrow(message);
      expect(h.artifacts.records).toHaveLength(0);
    },
  );

  it("keeps Git IDs flexible but content hashes strict SHA-256", () => {
    expect(gitCommitShaSchema.safeParse("a".repeat(40)).success).toBe(true);
    expect(gitCommitShaSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(gitCommitShaSchema.safeParse("a".repeat(63)).success).toBe(false);
  });

  it("requires an exact, single canonical frontmatter value", () => {
    expect(() => assertCanonicalFrontmatter(content, canonical)).not.toThrow();
    expect(() =>
      assertCanonicalFrontmatter(
        `${content}canonicalUrl: "${canonical}"\n`,
        canonical,
      ),
    ).not.toThrow();
    expect(() =>
      assertCanonicalFrontmatter(
        content.replace("---\n\n", `canonicalUrl: "${canonical}"\n---\n\n`),
        canonical,
      ),
    ).toThrow(/canonical/);
  });
});
