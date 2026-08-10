import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileProductionPublicationArtifactRepository } from "../../publication/storage";
import { LocalContentRepository } from "../../publication/repository";
import { publicationRecordSchema } from "../../publication/models";
import { productionArtifactFixture } from "../../publication/__tests__/production-artifact-fixture";
import { digest } from "../../publication/transform";
import { SocialService } from "../service";
import {
  FileSocialApprovalRepository,
  FileSocialExportRepository,
  FileSocialHistoryRepository,
  FileSocialJobRepository,
  FileSocialPackageRepository,
  FileSocialPostedRepository,
  FileSocialQualityRepository,
  FileSocialRevisionRepository,
  FileSocialTaskRepository,
} from "../storage";
import { createClaimIndex } from "../task";
import { fixtureSocialConfig as config } from "./fixture-config";
const now = "2026-08-06T12:00:00.000Z";
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "social-flow-")),
    publicationRoot = join(root, "publication"),
    socialRoot = join(root, "social"),
    blogRoot = join(root, "blog"),
    articlePath = "content/blog/2026/cache-update.mdx",
    canonicalUrl = "https://example.com/blog/cache-update",
    mdx = `---\ntitle: "Cache update analysis"\nslug: "cache-update"\ncanonicalUrl: "${canonicalUrl}"\nstatus: "published"\ndraft: false\n---\n\n## What changed\n\nVersion 4.2 may improve cache behavior for small teams, but regional availability remains uncertain.\n\n## Practical impact\n\nThe useful part is simpler configuration for teams that already use the supported runtime.\n\n## Limits\n\nThis is a source-based analysis and not hands-on testing. Compatibility still depends on the documented runtime version.\n\n## Recommendation\n\nTeams should verify compatibility before upgrading.\n`;
  await mkdir(join(blogRoot, "content/blog/2026"), { recursive: true });
  await writeFile(join(blogRoot, articlePath), mdx);
  const record = productionArtifactFixture(
    publicationRecordSchema.parse({
      id: "publication_aaaaaaaaaaaaaaaaaaaaaaaa",
      topicId: "topic-social",
      draftId: "draft_bbbbbbbbbbbbbbbbbbbbbbbb",
      draftVersion: 1,
      reviewId: "review_cccccccccccccccccccccccc",
      reviewVersion: 1,
      researchPacketId: "packet_dddddddddddddddddddddddd",
      researchPacketVersion: 1,
      finalApprovedEventId: "articleevent_eeeeeeeeeeeeeeeeeeeeeeee",
      status: "published",
      title: "Cache update analysis",
      slug: "cache-update",
      articlePath,
      repository: "fixture/blog",
      branch: "main",
      commitSha: "f".repeat(64),
      deploymentProvider: "mock",
      deploymentId: "mock",
      deploymentUrl: canonicalUrl,
      canonicalUrl,
      publishedAt: now,
      sourceCount: 1,
      contentHash: digest(mdx),
      approvedSnapshotHash: "1".repeat(64),
      publishedSnapshotHash: "2".repeat(64),
      createdAt: now,
      updatedAt: now,
      warnings: [],
      provenance: { mode: "fixture", parentSha: "0".repeat(64) },
      version: 1,
    }),
  );
  const publications = new FileProductionPublicationArtifactRepository(
    publicationRoot,
  );
  await publications.save(record);
  const packages = new FileSocialPackageRepository(socialRoot),
    posted = new FileSocialPostedRepository(socialRoot),
    service = new SocialService({
      publications,
      content: new LocalContentRepository(blogRoot),
      jobs: new FileSocialJobRepository(socialRoot),
      packages,
      quality: new FileSocialQualityRepository(packages),
      tasks: new FileSocialTaskRepository(join(root, "tasks/social")),
      approvals: new FileSocialApprovalRepository(socialRoot),
      history: new FileSocialHistoryRepository(socialRoot),
      exports: new FileSocialExportRepository(socialRoot),
      posted,
      revisions: new FileSocialRevisionRepository(
        join(root, "tasks/social-revision"),
      ),
      config,
      paths: {
        prompt: "prompts/social-package.md",
        audience: "brand/audience.md",
        writing: "brand/writing-style.md",
        editorial: "brand/editorial-rules.md",
        design: "brand/design-style.md",
      },
      clock: () => new Date(now),
    });
  return { root, service, record, mdx, posted };
}
function result(input: {
  publicationId: string;
  hash: string;
  version: number;
  taskHash: string;
  claims: ReturnType<typeof createClaimIndex>;
  xSuffix?: string;
}) {
  const ref =
      input.claims.find((x) => x.claimType === "analysis")?.id ??
      input.claims[0]!.id,
    disclosure =
      input.claims.find((x) => x.claimType === "disclosure")?.id ?? ref,
    link = "https://example.com/blog/cache-update",
    linkedin = `${"A practical cache update needs context, not hype. ".repeat(16)}Small teams can focus on configuration and compatibility before changing production systems. This remains source-based analysis, not hands-on testing. ${link}`,
    x = `Cache configuration may become simpler, but compatibility still matters${input.xSuffix ?? ""}. ${link}`;
  return {
    schemaVersion: "1.0",
    publicationId: input.publicationId,
    articleContentHash: input.hash,
    packageVersion: input.version,
    platforms: ["linkedin", "x", "instagram", "medium"],
    items: [
      {
        platform: "linkedin",
        contentType: "linkedin_post",
        text: linkedin,
        hashtags: ["#Software"],
        link,
        claimReferences: [ref, disclosure],
        sourcePublicationHash: input.hash,
      },
      {
        platform: "x",
        contentType: "x_post",
        text: x,
        hashtags: [],
        link,
        claimReferences: [ref],
        sourcePublicationHash: input.hash,
      },
      {
        platform: "x",
        contentType: "x_thread",
        thread: [
          "Cache changes need context.",
          "Configuration is only one part of rollout.",
          "Compatibility remains the practical constraint.",
          `Read the full analysis: ${link}`,
        ],
        hashtags: [],
        link,
        claimReferences: [ref],
        sourcePublicationHash: input.hash,
      },
      {
        platform: "instagram",
        contentType: "instagram_carousel",
        slides: Array.from({ length: 5 }, (_, i) => ({
          slideNumber: i + 1,
          headline: [
            "Cache update",
            "What changed",
            "Why it matters",
            "Compatibility",
            "Read more",
          ][i],
          body: [
            "A measured update.",
            "Configuration may get simpler.",
            "Small teams could benefit.",
            "Verify runtime support.",
            "See the published analysis.",
          ][i],
          visualDirection:
            "Abstract editorial diagram with clean grid and no product render",
          altText: `Slide ${i + 1} explaining the cache update`,
        })),
        hashtags: ["#Software", "#Development", "#Caching"],
        link,
        altText: "Carousel explaining a cache update",
        claimReferences: [ref],
        sourcePublicationHash: input.hash,
        visualBrief: {
          platform: "instagram",
          purpose: "Explain a software change",
          subject: "Abstract cache flow",
          composition: "Five clean editorial panels",
          aspectRatio: "4:5",
          typographyNeeds: "Large accessible headings",
          background: "Neutral dark surface",
          mood: "Precise",
          brandAlignment: "Minimal independent technology editorial",
          recommendation: "diagrammatic",
          officialAssetPreference: false,
          prohibitedElements: ["fake screenshots", "product renders"],
          misinformationRisk: "Low when kept abstract",
          altTextDraft: "Diagram explaining cache behavior",
        },
      },
      {
        platform: "instagram",
        contentType: "instagram_caption",
        text: `A measured look at cache configuration and compatibility. Full article at the link in bio when configured: ${link}`,
        hashtags: ["#Software", "#Development"],
        link,
        claimReferences: [ref],
        sourcePublicationHash: input.hash,
      },
      {
        platform: "medium",
        contentType: "medium_adaptation",
        title: "A measured plan for the cache update",
        text: `Adapt the introduction around team rollout decisions. Shorten the configuration background and expand compatibility limits. This is source-based analysis, not hands-on testing. The original article remains the primary publication: ${link}`,
        hashtags: [],
        link,
        claimReferences: [ref, disclosure],
        sourcePublicationHash: input.hash,
      },
    ],
    visualBriefs: [],
    imagePrompts: [
      {
        platform: "instagram",
        prompt:
          "Abstract editorial cache-flow diagram, no text, no logos, no product render",
        aspectRatio: "4:5",
        style: "diagrammatic",
        negativeInstructions: [
          "no fake screenshots",
          "no fabricated hardware",
          "no implied possession",
          "no unauthorized logos",
        ],
        altTextIntent: "Explain cache flow without implying testing",
      },
    ],
    timingSuggestions: [],
    disclosures: [],
    generatorNotes: [],
    unresolvedQuestions: [],
    provenance: { mode: "manual_claude_code", taskHash: input.taskHash },
  };
}
describe("offline social package flow", () => {
  it("prepares, imports, approves, schedules, revises, exports, and marks posted without APIs", async () => {
    const h = await harness(),
      prepared = await h.service.prepare(h.record.id, [
        "linkedin",
        "x",
        "instagram",
        "medium",
      ]),
      claims = createClaimIndex(h.mdx),
      first = await h.service.importValue(
        h.record.id,
        result({
          publicationId: h.record.id,
          hash: h.record.contentHash,
          version: 1,
          taskHash: prepared.taskHash,
          claims,
        }),
      );
    expect(first.reused).toBe(false);
    expect(first.quality.every((x) => x.status !== "blocked")).toBe(true);
    const duplicate = await h.service.importValue(
      h.record.id,
      result({
        publicationId: h.record.id,
        hash: h.record.contentHash,
        version: 1,
        taskHash: prepared.taskHash,
        claims,
      }),
    );
    expect(duplicate.reused).toBe(true);
    await h.service.approve(h.record.id, "linkedin", 1, "approve");
    await h.service.approve(h.record.id, "instagram", 1, "schedule", {
      publishAt: "2026-08-07T18:00",
    });
    const revision = await h.service.prepareRevision(
      h.record.id,
      1,
      "x_post_only",
      "Make X less promotional",
    );
    const second = await h.service.importValue(
      h.record.id,
      result({
        publicationId: h.record.id,
        hash: h.record.contentHash,
        version: 2,
        taskHash: revision.request.taskHash,
        claims,
        xSuffix: " in practice",
      }),
      1,
    );
    expect(second.pkg.version).toBe(2);
    const status = await h.service.status(h.record.id);
    expect(
      status.approvals.some(
        (x) => x.platform === "linkedin" && x.packageVersion === 2,
      ),
    ).toBe(true);
    const exports = await h.service.export(h.record.id, 2);
    expect(exports.some((x) => x.platform === "linkedin")).toBe(true);
    await expect(
      h.service.markPosted(
        h.record.id,
        "linkedin",
        "https://example.com/not-a-linkedin-post",
      ),
    ).rejects.toThrow(/Invalid public platform post URL/);
    expect(await h.posted.get(h.record.id, "linkedin")).toBeUndefined();
    const posted = await h.service.markPosted(
      h.record.id,
      "linkedin",
      "https://www.linkedin.com/posts/example",
    );
    expect(posted.method).toBe("manual");
    expect(
      await readFile(
        join(h.root, "social/exports", h.record.id, "v2/linkedin.txt"),
        "utf8",
      ),
    ).toContain("practical cache");
    await expect(
      readFile(
        join(h.root, "social/exports", h.record.id, "v2/export-records.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const publicExports = await Promise.all(
      [
        "linkedin.txt",
        "linkedin.md",
        "linkedin.json",
        "instagram-carousel.md",
        "instagram-caption.txt",
        "instagram-alt-text.txt",
        "instagram-visual-brief.json",
        "schedule.json",
      ].map((name) =>
        readFile(
          join(h.root, "social/exports", h.record.id, "v2", name),
          "utf8",
        ),
      ),
    );
    expect(publicExports.join("\n")).not.toMatch(
      /social(?:package|item|approval)_|telegramUpdateId|callbackQueryId|approvalNotes/,
    );
    expect(
      (
        await stat(
          join(h.root, "tasks/social", h.record.id, "v1/social-input.json"),
        )
      ).mode & 0o777,
    ).toBe(0o600);
  });
  it("rejects the source fixture publication", async () => {
    const h = await harness();
    await expect(
      h.service.prepare(h.record.sourcePublicationId),
    ).rejects.toThrow(/verified production publication/);
  });
  it("allows timing-only changes, scopes visual changes, and preserves only safe approvals", async () => {
    const h = await harness();
    const prepared = await h.service.prepare(h.record.id, [
      "linkedin",
      "x",
      "instagram",
      "medium",
    ]);
    const claims = createClaimIndex(h.mdx);
    await h.service.importValue(
      h.record.id,
      result({
        publicationId: h.record.id,
        hash: h.record.contentHash,
        version: 1,
        taskHash: prepared.taskHash,
        claims,
      }),
    );
    await h.service.approve(h.record.id, "linkedin", 1, "approve");
    await h.service.approve(h.record.id, "instagram", 1, "approve");

    const timingTask = await h.service.prepareRevision(
      h.record.id,
      1,
      "timing_only",
      "Move LinkedIn to Thursday morning",
    );
    const timingResult = result({
      publicationId: h.record.id,
      hash: h.record.contentHash,
      version: 2,
      taskHash: timingTask.request.taskHash,
      claims,
    });
    Object.assign(timingResult.items[0]!, {
      suggestedPublishAt: "2026-08-13T16:00:00.000Z",
      timezone: "America/Phoenix",
    });
    await h.service.importValue(h.record.id, timingResult, 1);
    let status = await h.service.status(h.record.id);
    expect(
      status.approvals.some(
        (x) => x.platform === "linkedin" && x.packageVersion === 2,
      ),
    ).toBe(true);

    const visualTask = await h.service.prepareRevision(
      h.record.id,
      2,
      "visual_brief_only",
      "Use a lighter abstract background",
    );
    const visualResult = result({
      publicationId: h.record.id,
      hash: h.record.contentHash,
      version: 3,
      taskHash: visualTask.request.taskHash,
      claims,
    });
    Object.assign(visualResult.items[0]!, {
      suggestedPublishAt: "2026-08-13T16:00:00.000Z",
      timezone: "America/Phoenix",
    });
    const carousel = visualResult.items.find(
      (item) => item.contentType === "instagram_carousel",
    );
    if (!carousel?.visualBrief) throw new Error("Fixture visual brief missing");
    carousel.visualBrief.background = "Light neutral editorial surface";
    await h.service.importValue(h.record.id, visualResult, 2);
    status = await h.service.status(h.record.id);
    expect(
      status.approvals.some(
        (x) =>
          x.platform === "instagram" &&
          x.packageVersion === 3 &&
          x.platformItemId ===
            status.pkg?.items.find(
              (item) => item.contentType === "instagram_caption",
            )?.id,
      ),
    ).toBe(true);
    expect(
      status.approvals.some(
        (x) =>
          x.packageVersion === 3 &&
          x.platformItemId ===
            status.pkg?.items.find(
              (item) => item.contentType === "instagram_carousel",
            )?.id,
      ),
    ).toBe(false);
  });
  it("rejects a revision that changes copy outside its declared scope", async () => {
    const h = await harness();
    const prepared = await h.service.prepare(h.record.id, [
      "linkedin",
      "x",
      "instagram",
      "medium",
    ]);
    const claims = createClaimIndex(h.mdx);
    await h.service.importValue(
      h.record.id,
      result({
        publicationId: h.record.id,
        hash: h.record.contentHash,
        version: 1,
        taskHash: prepared.taskHash,
        claims,
      }),
    );
    const revision = await h.service.prepareRevision(
      h.record.id,
      1,
      "linkedin_only",
      "Shorten LinkedIn",
    );
    const changed = result({
      publicationId: h.record.id,
      hash: h.record.contentHash,
      version: 2,
      taskHash: revision.request.taskHash,
      claims,
      xSuffix: " outside scope",
    });
    await expect(
      h.service.importValue(h.record.id, changed, 1),
    ).rejects.toThrow(/outside its scope/);
  });
});
