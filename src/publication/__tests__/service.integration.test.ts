import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileWorkflowArtifactRepository } from "../../database/artifacts";
import { sha256 } from "../../writing/task";
import type { ArticleFinalApprovedEvent } from "../../review/models";
import type { ArticleDraft, DraftQualityReport } from "../../writing/models";
import type { ResearchPacket } from "../../research/models";
import type {
  EditorialReviewResult,
  FinalApprovalRecord,
} from "../../review/models";
import { publicationConfigSchema } from "../config";
import { MockDeploymentProvider } from "../deployment";
import { LocalContentRepository } from "../repository";
import { PublicationService } from "../service";
import {
  FileDeploymentStatusRepository,
  FileEventConsumerRepository,
  FilePublicationJobRepository,
  FilePublicationRepository,
  FilePublicationVerificationRepository,
} from "../storage";
const now = "2026-08-06T12:00:00.000Z";
const config = publicationConfigSchema.parse({
  mode: "fixture",
  repository: "fixture/blog",
  defaultBranch: "main",
  branchStrategy: "direct",
  contentRoot: "content/blog",
  pathPattern: "content/blog/{year}/{slug}.mdx",
  siteOrigin: "https://example.com",
  blogRoutePrefix: "/blog",
  citationStyle: "numbered_footnotes",
  commitMessagePattern: "publish: add {title}",
  deploymentProvider: "mock",
  deploymentPolicy: "required",
  deploymentTimeoutSeconds: 60,
  pollIntervalSeconds: 2,
  publicPageVerification: false,
  maximumAttempts: 3,
  scheduledGraceMinutes: 60,
  claimTimeoutMinutes: 30,
  notifications: true,
});
function fixture(
  status: ArticleFinalApprovedEvent["status"] = "ready_for_publication",
  requestedPublishAt?: string,
) {
  const sourceId = "source_aaaaaaaaaaaaaaaaaaaaaaaa";
  const draft = {
    id: "draft_bbbbbbbbbbbbbbbbbbbbbbbb",
    topicId: "topic-fixture",
    candidateId: "candidate",
    researchPacketId: "packet_cccccccccccccccccccccccc",
    researchPacketVersion: 1,
    approvedEventId: "approved-topic-event",
    version: 1,
    status: "validated",
    articleType: "news_analysis",
    title: "A validated fixture publication title",
    slug: "fixture-publication",
    description:
      "A detailed fixture description that safely explains the publication pipeline behavior for validation.",
    category: "Software",
    tags: ["publication"],
    author: "Deep",
    heroImage: null,
    heroAlt: "Abstract publication flow",
    canonicalUrl: null,
    publishedAt: null,
    updatedAt: now,
    draft: true,
    mdx: `## Verified change\n\nThe fixture changed.[source:${sourceId}]`,
    plainText: "The fixture changed.",
    wordCount: 800,
    readingTimeMinutes: 4,
    headingOutline: [
      { level: 2, text: "Verified change" },
      { level: 2, text: "Impact" },
    ],
    sourceIds: [sourceId],
    claimReferences: [],
    researchContentHashes: ["1".repeat(64)],
    writingMode: "manual_claude_code",
    createdAt: now,
    provenance: {
      taskHash: "2".repeat(64),
      importHash: "3".repeat(64),
      importedAt: now,
      importedBy: "manual",
      schemaVersion: "1.0",
    },
    warnings: [],
  } as ArticleDraft;
  const review = {
    id: "review_dddddddddddddddddddddddd",
    version: 1,
    decision: "pass",
    issues: [],
  } as unknown as EditorialReviewResult;
  const packet = {
    id: draft.researchPacketId,
    version: 1,
    status: "ready",
    sufficient: true,
    sourceIndex: [
      {
        id: sourceId,
        canonicalUrl: "https://docs.example.com/release?utm_source=fixture",
        title: "Official release",
        publisher: "Example",
        publishedAt: now,
        isPrimary: true,
        sourceType: "official_announcement",
      },
    ],
  } as ResearchPacket;
  const approval = {
    status: status === "scheduled" ? "scheduled" : "approved",
    draftVersion: 1,
    reviewVersion: 1,
  } as FinalApprovalRecord;
  const quality = { status: "passed" } as DraftQualityReport;
  const event = {
    id: "articleevent_eeeeeeeeeeeeeeeeeeeeeeee",
    topicId: draft.topicId,
    candidateId: draft.candidateId,
    draftId: draft.id,
    draftVersion: 1,
    reviewId: review.id,
    reviewVersion: 1,
    researchPacketId: packet.id,
    researchPacketVersion: 1,
    approvedAt: now,
    approvedBy: { telegramUserId: "1", telegramChatId: "1" },
    approvalNotes: [],
    requestedPublishAt,
    requestedTimezone: requestedPublishAt ? "America/Phoenix" : undefined,
    articleSnapshotHash: sha256(
      JSON.stringify({
        draft,
        reviewId: review.id,
        reviewVersion: review.version,
        decision: review.decision,
      }),
    ),
    sourceIds: [sourceId],
    origin: "ranked",
    status,
    createdAt: now,
    version: 1,
  } as ArticleFinalApprovedEvent;
  return { draft, review, packet, approval, quality, event };
}
async function harness(
  deployment: "ready" | "failed" = "ready",
  event = fixture().event,
  configValue = config,
) {
  const root = await mkdtemp(join(tmpdir(), "publication-flow-"));
  const f = fixture(event.status, event.requestedPublishAt);
  f.event = event;
  const publications = new FilePublicationRepository(join(root, "state"));
  const calls: string[] = [];
  const service = new PublicationService({
    events: {
      async getById(id) {
        return id === event.id ? event : undefined;
      },
      async next() {
        return event;
      },
      async due() {
        return [event];
      },
    },
    jobs: new FilePublicationJobRepository(join(root, "state")),
    publications,
    consumption: new FileEventConsumerRepository(join(root, "state")),
    deployments: new FileDeploymentStatusRepository(join(root, "state")),
    verifications: new FilePublicationVerificationRepository(
      join(root, "state"),
    ),
    drafts: {
      async nextVersion() {
        return 2;
      },
      async get(_topic, version) {
        return version === undefined || version === 1 ? f.draft : undefined;
      },
      async findByImportHash() {
        return undefined;
      },
      async saveBundle() {},
    },
    quality: {
      async get() {
        return f.quality;
      },
    },
    packets: {
      async nextVersion() {
        return 2;
      },
      async save() {},
      async get() {
        return f.packet;
      },
      async getByImportHash() {
        return undefined;
      },
    },
    reviews: {
      async nextVersion() {
        return 2;
      },
      async get() {
        return f.review;
      },
      async findByImportHash() {
        return undefined;
      },
      async save() {},
      async resolveIssues() {},
    },
    approvals: {
      async get() {
        return f.approval;
      },
      async getByShortId() {
        return undefined;
      },
      async save() {},
      async list() {
        return [];
      },
    },
    gates: {
      async packet() {
        return f.packet;
      },
      async quality() {
        return f.quality;
      },
      async topicActive() {
        return true;
      },
      async topicOrigin() {
        return "ranked";
      },
    },
    repository: new LocalContentRepository(join(root, "blog")),
    deployment: new MockDeploymentProvider(() => new Date(now), deployment),
    notifications: {
      async started() {
        calls.push("started");
      },
      async committed() {
        calls.push("committed");
      },
      async published() {
        calls.push("published");
      },
      async failed() {
        calls.push("failed");
      },
    },
    config: configValue,
    tasks: new FileWorkflowArtifactRepository(join(root, "tasks")),
    clock: () => new Date(now),
  });
  return { service, root, calls, publications, event };
}
describe("complete offline publication flow", () => {
  it("publishes the exact approved version once and consumes once", async () => {
    const h = await harness();
    const first = await h.service.event(h.event.id);
    const second = await h.service.event(h.event.id);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(h.calls).toEqual(["started", "committed", "published"]);
    const state = JSON.parse(
      await readFile(join(h.root, "blog/.fixture-git/state.json"), "utf8"),
    ) as { commits: Record<string, unknown> };
    expect(Object.keys(state.commits)).toHaveLength(1);
    expect((await h.service.status(h.event.id)).consumption).toBeDefined();
    expect((await h.publications.list())[0]?.status).toBe("published");
  });
  it("keeps a failed required deployment unconsumed and does not duplicate commit on retry", async () => {
    const h = await harness("failed");
    await h.service.event(h.event.id);
    await h.service.event(h.event.id);
    const state = JSON.parse(
      await readFile(join(h.root, "blog/.fixture-git/state.json"), "utf8"),
    ) as { commits: Record<string, unknown> };
    expect(Object.keys(state.commits)).toHaveLength(1);
    expect((await h.service.status(h.event.id)).consumption).toBeUndefined();
    expect((await h.publications.list())[0]?.status).toBe("deployment_failed");
  });
  it("does not claim or publish scheduled events early", async () => {
    const f = fixture("scheduled", "2026-08-06T13:00:00.000Z");
    const h = await harness("ready", f.event);
    await expect(h.service.event(f.event.id)).rejects.toThrow(/not due/);
    expect((await h.service.status(f.event.id)).job).toBeUndefined();
  });
  it("dry-run validates without creating private or repository state", async () => {
    const h = await harness();
    const result = await h.service.event(h.event.id, "fixture-worker", true);
    expect(result.dryRun).toBe(true);
    expect((await h.service.status(h.event.id)).job).toBeUndefined();
    await expect(
      readFile(join(h.root, "blog/.fixture-git/state.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("manual policy creates a verification task and consumes only after a valid import", async () => {
    const manualConfig = publicationConfigSchema.parse({
      ...config,
      deploymentProvider: "manual",
      deploymentPolicy: "manual",
    });
    const h = await harness("ready", fixture().event, manualConfig);
    const result = await h.service.event(h.event.id);
    const publication =
      "publication" in result ? result.publication : undefined;
    if (!publication) throw new Error("Publication missing");
    expect(publication.status).toBe("verification_required");
    expect((await h.service.status(h.event.id)).consumption).toBeUndefined();
    await expect(
      readFile(
        join(h.root, "tasks", publication.id, "verify-publication.md"),
        "utf8",
      ),
    ).resolves.toContain("Verify publication");
    await h.service.importVerification(publication.id, {
      status: "verified",
      urlLoads: true,
      correctTitle: true,
      correctContent: true,
      correctCanonicalUrl: true,
      formattingOk: true,
      sourcesRender: true,
      noDraftBadge: true,
      mobileReadable: true,
      verifiedAt: now,
      notes: [],
    });
    expect((await h.service.status(h.event.id)).consumption).toBeDefined();
  });
});
