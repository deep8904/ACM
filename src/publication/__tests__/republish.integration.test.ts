import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ArticleFinalApprovedEvent } from "../../review/models";
import type { ArticleDraft } from "../../writing/models";
import type { EditorialReviewResult } from "../../review/models";
import { sha256 } from "../../writing/task";
import { publicationConfigSchema } from "../config";
import type { ContentRepository, RepositoryCommit } from "../interfaces";
import { gitCommitShaSchema, publicationRecordSchema } from "../models";
import {
  canonicalOnlyMigration,
  PublicationRepublishService,
} from "../republish";
import { LocalContentRepository } from "../repository";
import {
  FileEventConsumerRepository,
  FilePublicationRepository,
  FilePublicationRepublishRepository,
} from "../storage";
import { digest } from "../transform";

const now = "2026-08-09T19:32:19.822Z";
const sourcePublicationId = "publication_78b30f88ad9d7399fee7502b";
const eventId = "articleevent_022b92dda60924fe224e4392";
const sourcePath =
  "content/blog/2026/github-copilot-usage-metrics-agent-app-activity.mdx";
const sourceCanonical =
  "https://example.com/blog/github-copilot-usage-metrics-agent-app-activity";
const sourceContent = `---\ntitle: "GitHub Copilot Usage Metrics Now Separate Agent App Activity"\ncanonicalUrl: "${sourceCanonical}"\n---\n\nExact approved body.\n`;

const config = publicationConfigSchema.parse({
  mode: "github",
  repository: "deep8904/Deep-Blog",
  defaultBranch: "main",
  branchStrategy: "publication_branch",
  contentRoot: "content/blog",
  pathPattern: "content/blog/{year}/{slug}.mdx",
  siteOrigin: "https://replace-with-real-site-origin.invalid",
  blogRoutePrefix: "/blog",
  citationStyle: "numbered_footnotes",
  commitMessagePattern: "publish: add {title}",
  deploymentProvider: "manual",
  deploymentPolicy: "manual",
  deploymentTimeoutSeconds: 60,
  pollIntervalSeconds: 2,
  publicPageVerification: false,
  maximumAttempts: 3,
  scheduledGraceMinutes: 1440,
  claimTimeoutMinutes: 30,
  notifications: false,
});

class FailingTargetRepository extends LocalContentRepository {
  override async createCommitOnNewBranch(): Promise<RepositoryCommit> {
    throw new Error("simulated GitHub failure");
  }
}

class GitShaTargetRepository implements ContentRepository {
  readonly commitSha = "c".repeat(40);
  readonly parentSha = "a".repeat(40);
  createCalls = 0;
  private files = new Map<string, string>();
  private branchExists = false;

  async getDefaultBranch() {
    return "main";
  }
  async getFile(path: string, ref = "main") {
    const content =
      this.branchExists && ref !== "main" ? this.files.get(path) : undefined;
    return content === undefined
      ? null
      : { path, content, sha: "b".repeat(40) };
  }
  async findCaseInsensitiveFile() {
    return null;
  }
  async createBranch() {
    throw new Error("not used");
  }
  async createCommit(): Promise<RepositoryCommit> {
    throw new Error("not used");
  }
  async createCommitOnNewBranch(input: {
    branch: string;
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
    idempotencyKey: string;
  }) {
    if (this.branchExists) throw new Error("Branch conflict");
    if (input.expectedParentSha !== this.parentSha)
      throw new Error("Optimistic repository conflict");
    this.createCalls += 1;
    this.branchExists = true;
    for (const file of input.files) this.files.set(file.path, file.content);
    return this.commit(input.branch);
  }
  async updateRef() {
    throw new Error("not used");
  }
  async getCommit(value: string) {
    if (value === "main")
      return {
        sha: this.parentSha,
        parentSha: this.parentSha,
        branch: "main",
      };
    if (this.branchExists) return this.commit(value);
    return null;
  }
  async isAncestor(ancestorSha: string, descendantSha: string) {
    return ancestorSha === descendantSha || ancestorSha === this.parentSha;
  }
  seed(path: string, content: string) {
    this.files.set(path, content);
    this.branchExists = true;
  }
  private commit(branch: string) {
    return {
      sha: this.commitSha,
      parentSha: this.parentSha,
      branch,
      url: `https://github.com/deep8904/Deep-Blog/commit/${this.commitSha}`,
    };
  }
}

async function harness(options?: {
  alteredSource?: boolean;
  failing?: boolean;
  targetRepository?: ContentRepository;
}) {
  const root = await mkdtemp(join(tmpdir(), "publication-republish-"));
  const stateRoot = join(root, "state");
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const fullSourcePath = join(sourceRoot, sourcePath);
  await mkdir(dirname(fullSourcePath), { recursive: true });
  await writeFile(
    fullSourcePath,
    options?.alteredSource ? `${sourceContent}altered\n` : sourceContent,
  );

  const draft = {
    id: "draft_32b9fb84e9022bb4d5d29cbd",
    topicId: "topic_9c253f2364d144a325557472",
    version: 1,
  } as ArticleDraft;
  const review = {
    id: "review_c646b21372ba375a6ce2e9ed",
    version: 1,
    decision: "pass_with_warnings",
  } as EditorialReviewResult;
  const approvedSnapshotHash = sha256(
    JSON.stringify({
      draft,
      reviewId: review.id,
      reviewVersion: review.version,
      decision: review.decision,
    }),
  );
  const publishedSnapshotHash = "3".repeat(64);
  const event = {
    id: eventId,
    topicId: draft.topicId,
    draftId: draft.id,
    draftVersion: 1,
    reviewId: review.id,
    reviewVersion: 1,
    researchPacketId: "packet_1bcebee610be4a6aa77d05b1",
    researchPacketVersion: 7,
    articleSnapshotHash: approvedSnapshotHash,
  } as ArticleFinalApprovedEvent;
  const publications = new FilePublicationRepository(stateRoot);
  const republishes = new FilePublicationRepublishRepository(stateRoot);
  const consumption = new FileEventConsumerRepository(stateRoot);
  await publications.save(
    publicationRecordSchema.parse({
      id: sourcePublicationId,
      topicId: draft.topicId,
      draftId: draft.id,
      draftVersion: 1,
      reviewId: review.id,
      reviewVersion: 1,
      researchPacketId: event.researchPacketId,
      researchPacketVersion: 7,
      finalApprovedEventId: event.id,
      status: "published",
      title: "GitHub Copilot Usage Metrics Now Separate Agent App Activity",
      slug: "github-copilot-usage-metrics-agent-app-activity",
      articlePath: sourcePath,
      repository: "deep8904/Deep-Blog",
      branch: "main",
      commitSha: "4".repeat(64),
      deploymentProvider: "mock",
      deploymentId: "mock",
      deploymentUrl: sourceCanonical,
      canonicalUrl: sourceCanonical,
      publishedAt: now,
      sourceCount: 3,
      contentHash: digest(sourceContent),
      approvedSnapshotHash,
      publishedSnapshotHash,
      createdAt: now,
      updatedAt: now,
      warnings: [],
      provenance: { mode: "fixture", parentSha: "0".repeat(64) },
      version: 2,
    }),
  );
  await consumption.consume({
    finalApprovedEventId: event.id,
    consumerId: "fixture-worker",
    publicationId: sourcePublicationId,
    commitSha: "4".repeat(64),
    deploymentId: "mock",
    verificationState: "verified",
    consumedAt: now,
    snapshotHash: approvedSnapshotHash,
  });
  const sourceRepository = new LocalContentRepository(sourceRoot);
  const targetRepository =
    options?.targetRepository ??
    (options?.failing
      ? new FailingTargetRepository(targetRoot)
      : new LocalContentRepository(targetRoot));
  const service = new PublicationRepublishService({
    publications,
    republishes,
    consumption,
    events: {
      async getById(id) {
        return id === event.id ? event : undefined;
      },
      async next() {
        return undefined;
      },
      async due() {
        return [];
      },
    },
    drafts: {
      async nextVersion() {
        return 2;
      },
      async get() {
        return draft;
      },
      async findByImportHash() {
        return undefined;
      },
      async saveBundle() {},
    },
    reviews: {
      async nextVersion() {
        return 2;
      },
      async get() {
        return review;
      },
      async findByImportHash() {
        return undefined;
      },
      async save() {},
      async resolveIssues() {},
    },
    sourceRepository,
    targetRepository,
    config,
    clock: () => new Date(now),
  });
  const request = {
    sourcePublicationId,
    expectedRepository: config.repository,
    expectedBaseBranch: config.defaultBranch,
    expectedSourceContentHash: digest(sourceContent),
    expectedApprovedSnapshotHash: approvedSnapshotHash,
    expectedPublishedSnapshotHash: publishedSnapshotHash,
    dryRun: false,
  };
  return {
    service,
    request,
    root,
    targetRoot,
    republishes,
    consumption,
    event,
  };
}

describe("fixture-to-GitHub republishing", () => {
  it("enforces the exact fixture artifact hash", async () => {
    const h = await harness({ alteredSource: true });
    await expect(h.service.republish(h.request)).rejects.toThrow(
      /artifact content hash mismatch/,
    );
  });

  it("preserves the consumed final-approved event during dry-run", async () => {
    const h = await harness();
    const before = await h.consumption.get(h.event.id);
    const result = await h.service.republish({ ...h.request, dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      sourceContentHash: digest(sourceContent),
    });
    expect(await h.consumption.get(h.event.id)).toEqual(before);
    expect(await h.republishes.list()).toEqual([]);
  });

  it("is idempotent for the same target repository, branch, and content", async () => {
    const h = await harness();
    const first = await h.service.republish(h.request);
    const second = await h.service.republish(h.request);
    expect(first).toMatchObject({ reused: false });
    expect(second).toMatchObject({ reused: true });
    expect(await h.republishes.list()).toHaveLength(1);
  });

  it("accepts 40-character Git commit SHAs while content hashes remain SHA-256", async () => {
    const targetRepository = new GitShaTargetRepository();
    const h = await harness({ targetRepository });
    const result = await h.service.republish(h.request);
    if (!result.republish) throw new Error("Expected a saved republish record");
    expect(result.republish.commitSha).toBe(targetRepository.commitSha);
    expect(result.republish.provenance.parentSha).toBe(
      targetRepository.parentSha,
    );
    expect(result.republish.targetContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(gitCommitShaSchema.safeParse("d".repeat(40)).success).toBe(true);
    expect(gitCommitShaSchema.safeParse("d".repeat(64)).success).toBe(true);
    expect(gitCommitShaSchema.safeParse("d".repeat(41)).success).toBe(false);
    await expect(
      h.republishes.save({
        ...result.republish,
        targetContentHash: "d".repeat(40),
      }),
    ).rejects.toThrow();
  });

  it("recovers a verified partial GitHub branch without creating another commit", async () => {
    const targetRepository = new GitShaTargetRepository();
    targetRepository.seed(
      sourcePath,
      canonicalOnlyMigration(
        sourceContent,
        sourceCanonical,
        `${config.siteOrigin}/blog/github-copilot-usage-metrics-agent-app-activity`,
      ),
    );
    const h = await harness({ targetRepository });
    const result = await h.service.republish(h.request);
    expect(result).toMatchObject({ reused: false });
    expect(targetRepository.createCalls).toBe(0);
    expect(await h.republishes.list()).toHaveLength(1);
  });

  it("rejects wrong repository, base branch, and expected content", async () => {
    const h = await harness();
    await expect(
      h.service.republish({ ...h.request, expectedRepository: "other/repo" }),
    ).rejects.toThrow(/repository/);
    await expect(
      h.service.republish({ ...h.request, expectedBaseBranch: "trunk" }),
    ).rejects.toThrow(/base branch/);
    await expect(
      h.service.republish({
        ...h.request,
        expectedSourceContentHash: "f".repeat(64),
      }),
    ).rejects.toThrow(/content hash/);
  });

  it("records immutable fixture-to-GitHub lineage", async () => {
    const h = await harness();
    const result = await h.service.republish(h.request);
    expect(result).toMatchObject({
      republish: {
        sourcePublicationId,
        sourceFinalApprovedEventId: eventId,
        repository: "deep8904/Deep-Blog",
        baseBranch: "main",
        status: "verification_required",
        provenance: {
          mode: "github_republish",
          sourceMode: "fixture",
          sourcePublicationId,
          transformation: "canonical_url_only",
        },
      },
    });
  });

  it("does not create lineage state or change consumption on GitHub failure", async () => {
    const h = await harness({ failing: true });
    const before = await h.consumption.get(h.event.id);
    await expect(h.service.republish(h.request)).rejects.toThrow(
      /simulated GitHub failure/,
    );
    expect(await h.republishes.list()).toEqual([]);
    expect(await h.consumption.get(h.event.id)).toEqual(before);
    await expect(
      readFile(join(h.targetRoot, ".fixture-git/state.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
