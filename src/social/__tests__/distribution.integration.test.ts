import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { productionArtifactFixture } from "../../publication/__tests__/production-artifact-fixture";
import { publicationRecordSchema } from "../../publication/models";
import { LocalContentRepository } from "../../publication/repository";
import { FileProductionPublicationArtifactRepository } from "../../publication/storage";
import { digest } from "../../publication/transform";
import { SocialDistributionService } from "../distribution";
import type { SocialPublisher } from "../interfaces";
import { SocialPublisherRegistry } from "../publishers";
import { SocialService } from "../service";
import {
  FileSocialApprovalRepository,
  FileSocialAssetRepository,
  FileSocialDistributionPlanRepository,
  FileSocialExportRepository,
  FileSocialHistoryRepository,
  FileSocialJobRepository,
  FileSocialPackageRepository,
  FileSocialPostedRepository,
  FileSocialQualityRepository,
  FileSocialRevisionRepository,
  FileSocialTaskRepository,
} from "../storage";
import { fixtureSocialConfig } from "./fixture-config";

const now = "2026-08-09T18:00:00.000Z";

async function harness(
  options: {
    carouselMin?: number;
    publishers?: SocialPublisher[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "social-distribution-"));
  const publicationRoot = join(root, "publication");
  const socialRoot = join(root, "social");
  const taskRoot = join(root, "tasks");
  const blogRoot = join(root, "blog");
  const articlePath = "content/blog/2026/cache-update.mdx";
  const canonicalUrl = "https://deep.example/writing/cache-update";
  const mdx = `---\ntitle: "Cache update analysis"\nslug: "cache-update"\ncanonicalUrl: "${canonicalUrl}"\nstatus: "published"\ndraft: false\n---\n\n## What changed\n\nVersion 4.2 may improve cache behavior for small teams, but regional availability remains uncertain.\n\n## Practical impact\n\nThe useful part is simpler configuration for teams that already use the supported runtime.\n\n## Limits\n\nThis is a source-based analysis and not hands-on testing. Compatibility still depends on the documented runtime version.\n\n## Recommendation\n\nTeams should verify compatibility before upgrading.\n`;
  await mkdir(join(blogRoot, "content/blog/2026"), { recursive: true });
  await writeFile(join(blogRoot, articlePath), mdx);
  const source = publicationRecordSchema.parse({
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
  });
  const record = productionArtifactFixture(source);
  const publications = new FileProductionPublicationArtifactRepository(
    publicationRoot,
  );
  await publications.save(record);
  const packages = new FileSocialPackageRepository(socialRoot);
  const exports = new FileSocialExportRepository(socialRoot);
  const approvals = new FileSocialApprovalRepository(socialRoot);
  const assets = new FileSocialAssetRepository(socialRoot);
  const plans = new FileSocialDistributionPlanRepository(socialRoot);
  const config = {
    ...fixtureSocialConfig,
    carouselMin: options.carouselMin ?? fixtureSocialConfig.carouselMin,
  };
  const social = new SocialService({
    publications,
    content: new LocalContentRepository(blogRoot),
    jobs: new FileSocialJobRepository(socialRoot),
    packages,
    quality: new FileSocialQualityRepository(packages),
    tasks: new FileSocialTaskRepository(taskRoot),
    approvals,
    history: new FileSocialHistoryRepository(socialRoot),
    exports,
    posted: new FileSocialPostedRepository(socialRoot),
    revisions: new FileSocialRevisionRepository(join(root, "revisions")),
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
  const distribution = new SocialDistributionService({
    social,
    plans,
    assets,
    packages,
    exports,
    publishers: new SocialPublisherRegistry(options.publishers),
    config,
    clock: () => new Date(now),
  });
  return {
    root,
    record,
    social,
    distribution,
    plans,
    packages,
    approvals,
    assets,
    exports,
  };
}

async function select(
  distribution: SocialDistributionService,
  publicationId: string,
  selected: Array<"linkedin" | "x" | "instagram" | "medium">,
) {
  let plan = await distribution.offer(publicationId);
  for (const platform of selected)
    plan = await distribution.toggle(plan.id, platform, plan.selectionRevision);
  return plan;
}

describe("consolidated social distribution", () => {
  it.each([
    { selected: ["linkedin"] },
    { selected: ["linkedin", "instagram"] },
    { selected: ["linkedin", "x", "instagram", "medium"] },
  ] as const)(
    "selects only the requested platform set $selected",
    async ({ selected }) => {
      const h = await harness();
      const plan = await select(h.distribution, h.record.id, [
        ...selected,
      ] as Array<"linkedin" | "x" | "instagram" | "medium">);
      expect(plan.selectedPlatforms).toEqual(selected);
      expect(await h.packages.get(h.record.id)).toBeUndefined();
      expect(await h.assets.list(plan.id)).toEqual([]);
    },
  );

  it("toggles selection idempotently for replayed authenticated callbacks", async () => {
    const h = await harness();
    const plan = await h.distribution.offer(h.record.id);
    const callback = {
      telegramUpdateId: 10,
      callbackQueryId: "callback-10",
      actorUserId: "123",
    };
    const selected = await h.distribution.toggle(
      plan.id,
      "linkedin",
      0,
      callback,
    );
    const replay = await h.distribution.toggle(
      plan.id,
      "linkedin",
      0,
      callback,
    );
    expect(replay).toEqual(selected);
    expect(
      (await h.plans.listEvents(plan.id)).filter(
        (event) => event.callbackQueryId === "callback-10",
      ),
    ).toHaveLength(1);
  });

  it("prepares only LinkedIn and Instagram with deterministic accessible PNGs", async () => {
    const h = await harness();
    const plan = await select(h.distribution, h.record.id, [
      "linkedin",
      "instagram",
    ]);
    const prepared = await h.distribution.prepare(
      plan.id,
      plan.selectionRevision,
    );
    expect(prepared.plan.status, JSON.stringify(prepared.quality)).toBe(
      "ready_for_confirmation",
    );
    const pkg = await h.packages.get(h.record.id, prepared.plan.packageVersion);
    expect(pkg?.platforms).toEqual(["linkedin", "instagram"]);
    expect(new Set(pkg?.items.map((item) => item.platform))).toEqual(
      new Set(["linkedin", "instagram"]),
    );
    expect(
      pkg?.items.some(
        (item) => item.platform === "x" || item.platform === "medium",
      ),
    ).toBe(false);
    const carousel = pkg?.items.find(
      (item) => item.contentType === "instagram_carousel",
    );
    expect(carousel?.slides).toHaveLength(6);
    expect(carousel?.altText?.length).toBeLessThanOrEqual(1000);
    expect(carousel?.slides?.every((slide) => slide.altText.length > 20)).toBe(
      true,
    );
    const assets = await h.assets.list(plan.id);
    expect(assets).toHaveLength(7);
    for (const asset of assets) {
      const bytes = await readFile(asset.path);
      const metadata = await sharp(bytes).metadata();
      expect([`${metadata.width}x${metadata.height}`]).toEqual([
        asset.platform === "instagram" ? "1080x1350" : "1200x627",
      ]);
      expect(digest(bytes.toString("base64"))).not.toBe("");
    }
  });

  it("approves all selected quality-passed items once and creates one manual bundle", async () => {
    const h = await harness();
    const selected = await select(h.distribution, h.record.id, [
      "linkedin",
      "instagram",
    ]);
    const prepared = await h.distribution.prepare(
      selected.id,
      selected.selectionRevision,
    );
    const confirmed = await h.distribution.confirm(selected.id);
    expect(confirmed.plan.status).toBe("manual_ready");
    expect(
      confirmed.plan.platformStates.every(
        (state) => state.state === "manual_ready",
      ),
    ).toBe(true);
    const pkg = await h.packages.get(h.record.id, prepared.plan.packageVersion);
    const approvals = await h.approvals.list(pkg!.id);
    expect(approvals).toHaveLength(pkg!.items.length);
    expect(approvals.every((approval) => approval.status === "approved")).toBe(
      true,
    );
    const retry = await h.distribution.confirm(selected.id);
    expect(retry.assets).toHaveLength(7);
    expect(
      retry.exports.some(
        (record) => record.path === "distribution-manifest.json",
      ),
    ).toBe(true);
    const exportPlatforms = new Set(
      retry.exports.map((record) => record.platform),
    );
    expect(exportPlatforms).toEqual(new Set(["linkedin", "instagram"]));

    const bundle = await h.distribution.materializeAssets(
      selected.id,
      join(h.root, "manual-bundle"),
    );
    expect(bundle.files).toEqual(
      expect.arrayContaining([
        "distribution-manifest.json",
        "instagram-alt-text.txt",
        "instagram-caption.txt",
        "instagram-carousel.md",
        "linkedin.txt",
      ]),
    );
    expect(bundle.files.some((name) => name.startsWith("x-"))).toBe(false);
    expect(bundle.files.some((name) => name.startsWith("medium-"))).toBe(false);
    expect(bundle.assets).toHaveLength(7);
    for (const asset of bundle.assets)
      await expect(readFile(asset.path)).resolves.toBeDefined();
  });

  it("resumes the same authenticated confirmation after an interrupted provider call", async () => {
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary provider failure"))
      .mockResolvedValueOnce({
        confirmed: true,
        postUrl: "https://www.linkedin.com/posts/deep-confirmed",
      });
    const provider: SocialPublisher = {
      id: "linkedin_official_api",
      platform: "linkedin",
      isConfigured: () => true,
      capabilities: () => ({
        canAutoPost: true,
        supportsImages: true,
        supportsCarousel: false,
        supportsThreads: false,
        supportsDrafts: false,
      }),
      publish,
    };
    const h = await harness({ publishers: [provider] });
    const selected = await select(h.distribution, h.record.id, ["linkedin"]);
    await h.distribution.prepare(selected.id, selected.selectionRevision);
    const callback = {
      telegramUpdateId: 45,
      callbackQueryId: "confirm-retry-45",
      actorUserId: "123",
    };
    await expect(h.distribution.confirm(selected.id, callback)).rejects.toThrow(
      /temporary provider failure/,
    );
    expect((await h.plans.get(selected.id))?.status).toBe("approved");

    const retried = await h.distribution.confirm(selected.id, callback);
    expect(retried.plan.status).toBe("completed");
    expect(publish).toHaveBeenCalledTimes(2);
    const pkg = await h.packages.get(h.record.id, retried.plan.packageVersion);
    expect(await h.approvals.list(pkg!.id)).toHaveLength(1);
    expect(
      (await h.plans.listEvents(selected.id)).filter(
        (event) => event.callbackQueryId === callback.callbackQueryId,
      ),
    ).toHaveLength(1);
  });

  it("regenerates into a new immutable package and exposes only current assets", async () => {
    const h = await harness();
    const selected = await select(h.distribution, h.record.id, ["linkedin"]);
    const first = await h.distribution.prepare(
      selected.id,
      selected.selectionRevision,
    );
    const second = await h.distribution.prepare(
      selected.id,
      selected.selectionRevision,
      undefined,
      true,
    );
    expect(first.plan.packageVersion).toBe(1);
    expect(second.plan.packageVersion).toBe(2);
    expect(await h.packages.get(h.record.id, 1)).toBeDefined();
    expect(await h.packages.get(h.record.id, 2)).toBeDefined();
    const firstPackage = await h.packages.get(h.record.id, 1);
    const secondPackage = await h.packages.get(h.record.id, 2);
    expect(firstPackage?.items[0]?.id).not.toBe(secondPackage?.items[0]?.id);
    expect(second.assets).toHaveLength(1);
    expect(second.assets[0]?.id).toBe(first.assets[0]?.id);
    expect(await h.assets.list(selected.id)).toHaveLength(1);
  });

  it("blocks consolidated confirmation when a single item fails quality", async () => {
    const h = await harness({ carouselMin: 7 });
    const selected = await select(h.distribution, h.record.id, [
      "linkedin",
      "instagram",
    ]);
    const prepared = await h.distribution.prepare(
      selected.id,
      selected.selectionRevision,
    );
    expect(prepared.plan.status).toBe("blocked");
    expect(
      prepared.plan.platformStates.find(
        (state) => state.platform === "instagram",
      )?.state,
    ).toBe("blocked");
    await expect(h.distribution.confirm(selected.id)).rejects.toThrow(
      /blocking platform item/,
    );
  });

  it("prepares a Medium text adaptation with two embedded-image assets", async () => {
    const h = await harness();
    const selected = await select(h.distribution, h.record.id, ["medium"]);
    const prepared = await h.distribution.prepare(
      selected.id,
      selected.selectionRevision,
    );
    expect(prepared.plan.status, JSON.stringify(prepared.quality)).toBe(
      "ready_for_confirmation",
    );
    const pkg = await h.packages.get(h.record.id, prepared.plan.packageVersion);
    const medium = pkg?.items.find(
      (item) => item.contentType === "medium_adaptation",
    );
    expect(medium?.text).toContain("## Why it matters");
    expect(medium?.assetIds).toHaveLength(2);
    expect(
      prepared.assets.filter((asset) => asset.kind === "medium_inline"),
    ).toHaveLength(2);
    expect(
      prepared.assets.every(
        (asset) => asset.width === 1200 && asset.height === 675,
      ),
    ).toBe(true);
  });

  it("builds a complete selected-only manual bundle for every platform format", async () => {
    const h = await harness();
    const selected = await select(h.distribution, h.record.id, [
      "linkedin",
      "x",
      "instagram",
      "medium",
    ]);
    const prepared = await h.distribution.prepare(
      selected.id,
      selected.selectionRevision,
    );
    expect(prepared.plan.status, JSON.stringify(prepared.quality)).toBe(
      "ready_for_confirmation",
    );
    const confirmed = await h.distribution.confirm(selected.id);
    expect(confirmed.plan.status).toBe("manual_ready");
    const files = await h.exports.readFiles(
      h.record.id,
      confirmed.plan.packageVersion!,
    );
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "linkedin.txt",
        "x-post.txt",
        "x-thread.txt",
        "instagram-caption.txt",
        "instagram-carousel.md",
        "instagram-alt-text.txt",
        "medium-adaptation.md",
        "distribution-manifest.json",
      ]),
    );
    expect(confirmed.assets).toHaveLength(10);
    expect(
      confirmed.assets.filter((asset) => asset.platform === "linkedin"),
    ).toHaveLength(1);
    expect(
      confirmed.assets.filter((asset) => asset.platform === "x"),
    ).toHaveLength(1);
    expect(
      confirmed.assets.filter((asset) => asset.platform === "instagram"),
    ).toHaveLength(6);
    expect(
      confirmed.assets.filter((asset) => asset.platform === "medium"),
    ).toHaveLength(2);
  });

  it("falls back to manual when an auto-capable provider is not configured", async () => {
    const publish = vi.fn();
    const provider: SocialPublisher = {
      id: "linkedin_official_api",
      platform: "linkedin",
      isConfigured: () => false,
      capabilities: () => ({
        canAutoPost: true,
        supportsImages: true,
        supportsCarousel: false,
        supportsThreads: false,
        supportsDrafts: false,
      }),
      publish,
    };
    const h = await harness({ publishers: [provider] });
    const selected = await select(h.distribution, h.record.id, ["linkedin"]);
    await h.distribution.prepare(selected.id, selected.selectionRevision);
    const result = await h.distribution.confirm(selected.id);
    expect(result.plan.status).toBe("manual_ready");
    expect(publish).not.toHaveBeenCalled();
  });

  it("gates auto-posting on configured capability and provider confirmation", async () => {
    const publish = vi.fn(async () => ({
      confirmed: true,
      postUrl: "https://www.linkedin.com/posts/deep-confirmed",
      providerPostId: "confirmed-1",
    }));
    const provider: SocialPublisher = {
      id: "linkedin_official_api",
      platform: "linkedin",
      isConfigured: () => true,
      capabilities: () => ({
        canAutoPost: true,
        supportsImages: true,
        supportsCarousel: false,
        supportsThreads: false,
        supportsDrafts: false,
      }),
      publish,
    };
    const h = await harness({ publishers: [provider] });
    const selected = await select(h.distribution, h.record.id, ["linkedin"]);
    await h.distribution.prepare(selected.id, selected.selectionRevision);
    const result = await h.distribution.confirm(selected.id);
    expect(result.plan.status).toBe("completed");
    expect(result.plan.platformStates[0]?.state).toBe("posted");
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
