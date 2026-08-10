import { digest } from "../publication/transform";
import { sha256 } from "../writing/task";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SocialConfig } from "./config";
import { buildDeterministicSocialContent } from "./deterministic";
import type {
  SocialAssetRepository,
  SocialDistributionPlanRepository,
  SocialExportRepository,
  SocialPackageRepository,
} from "./interfaces";
import {
  platformContentItemSchema,
  socialDistributionEventSchema,
  socialDistributionPlanSchema,
  socialExportSchema,
  socialPackageSchema,
  type SocialDistributionEvent,
  type SocialDistributionPlan,
  type SocialPlatform,
  type SocialAsset,
  type PlatformContentItem,
} from "./models";
import { SocialPublisherRegistry } from "./publishers";
import { validateSocialItem } from "./quality";
import { renderSocialAsset } from "./renderer";
import type { SocialService } from "./service";
import { createClaimIndex, publicArticleText } from "./task";

const platforms: SocialPlatform[] = ["linkedin", "x", "instagram", "medium"];

export class SocialDistributionService {
  constructor(
    private readonly d: {
      social: SocialService;
      plans: SocialDistributionPlanRepository;
      assets: SocialAssetRepository;
      packages: SocialPackageRepository;
      exports: SocialExportRepository;
      publishers: SocialPublisherRegistry;
      config: SocialConfig;
      clock?: () => Date;
    },
  ) {}

  private now() {
    return (this.d.clock ?? (() => new Date()))().toISOString();
  }

  async offer(publicationId: string) {
    const record = await this.d.social.getEligiblePublication(publicationId);
    const existing = await this.d.plans.getByPublication(publicationId);
    if (existing) {
      if (existing.articleContentHash !== record.contentHash)
        throw new Error(
          "Existing distribution plan targets stale article content",
        );
      return existing;
    }
    const now = this.now();
    const plan = socialDistributionPlanSchema.parse({
      id: `socialplan_${sha256(publicationId).slice(0, 24)}`,
      publicationId,
      articleContentHash: record.contentHash,
      articleTitle: record.title,
      canonicalUrl: record.canonicalUrl,
      status: "selecting",
      selectedPlatforms: [],
      platformStates: [],
      selectionRevision: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.d.plans.save(plan);
    await this.event(plan, "created");
    return plan;
  }

  async toggle(
    planId: string,
    platform: SocialPlatform,
    expectedRevision: number,
    callback?: CallbackContext,
  ) {
    const plan = await this.required(planId);
    if (await this.isReplay(planId, callback)) return plan;
    if (plan.status !== "selecting")
      throw new Error("Platform selection is already closed");
    if (plan.selectionRevision !== expectedRevision)
      throw new Error("Stale platform selection callback");
    const selected = plan.selectedPlatforms.includes(platform)
      ? plan.selectedPlatforms.filter((value) => value !== platform)
      : [...plan.selectedPlatforms, platform].sort(orderPlatforms);
    const next = socialDistributionPlanSchema.parse({
      ...plan,
      selectedPlatforms: selected,
      platformStates: selected.map((value) => this.initialPlatform(value)),
      selectionRevision: plan.selectionRevision + 1,
      version: plan.version + 1,
      updatedAt: this.now(),
    });
    if (!(await this.event(next, "platform_toggled", platform, callback)))
      return this.required(planId);
    await this.d.plans.save(next);
    return next;
  }

  async prepare(
    planId: string,
    expectedRevision?: number,
    callback?: CallbackContext,
    regenerate = false,
  ) {
    let plan = await this.required(planId);
    if (await this.isReplay(planId, callback)) return this.status(plan.id);
    if (
      !regenerate &&
      [
        "ready_for_confirmation",
        "approved",
        "manual_ready",
        "completed",
      ].includes(plan.status)
    )
      return this.status(plan.id);
    if (
      !["selecting", "failed"].includes(plan.status) &&
      !(
        regenerate &&
        ["ready_for_confirmation", "blocked"].includes(plan.status)
      )
    )
      throw new Error(
        "Distribution plan cannot be prepared from its current state",
      );
    if (
      expectedRevision !== undefined &&
      plan.selectionRevision !== expectedRevision
    )
      throw new Error("Stale prepare callback");
    if (!plan.selectedPlatforms.length)
      throw new Error("Select at least one social platform");

    plan = socialDistributionPlanSchema.parse({
      ...plan,
      status: "preparing",
      version: plan.version + 1,
      updatedAt: this.now(),
    });
    if (
      !(await this.event(
        plan,
        regenerate ? "regenerated" : "preparation_started",
        undefined,
        callback,
      ))
    )
      return this.status(plan.id);
    await this.d.plans.save(plan);

    try {
      const { record, mdx } = await this.d.social.getPublishedArticle(
        plan.publicationId,
      );
      const version = await this.d.packages.nextVersion(plan.publicationId);
      const packageId = `socialpackage_${sha256(`${plan.id}:${version}:${record.contentHash}`).slice(0, 24)}`;
      const claims = createClaimIndex(mdx);
      const generated = buildDeterministicSocialContent({
        planId: plan.id,
        publicationId: plan.publicationId,
        packageId,
        packageVersion: version,
        articleContentHash: record.contentHash,
        title: record.title,
        canonicalUrl: record.canonicalUrl,
        claims,
        platforms: plan.selectedPlatforms,
        config: this.d.config,
        now: this.now(),
      });
      const renderedOutputs = await Promise.all(
        generated.renders.map((request) =>
          renderSocialAsset({ ...request, createdAt: plan.updatedAt }),
        ),
      );
      const rendered = await Promise.all(
        renderedOutputs.map(async (output) => ({
          ...output,
          asset:
            (await this.d.assets.findByContentHash(
              plan.id,
              output.asset.contentHash,
            )) ?? output.asset,
        })),
      );
      const items = generated.items.map((item) =>
        platformContentItemSchema.parse({
          ...item,
          assetIds: rendered
            .filter(({ asset }) => asset.platform === item.platform)
            .map(({ asset }) => asset.id),
        }),
      );
      const quality = items.map((item) =>
        validateSocialItem(item, {
          canonicalUrl: record.canonicalUrl,
          articleText: publicArticleText(mdx),
          claims,
          config: this.d.config,
          now: plan.updatedAt,
          packageId,
          packageVersion: version,
        }),
      );
      const blocked = new Set(
        quality
          .filter((report) => report.status === "blocked")
          .map((report) => report.platform),
      );
      const importHash = sha256(
        JSON.stringify({
          planId: plan.id,
          version,
          selected: plan.selectedPlatforms,
          items,
        }),
      );
      const pkg = socialPackageSchema.parse({
        id: packageId,
        publicationId: plan.publicationId,
        topicId: record.topicId,
        articleSlug: record.slug,
        articleTitle: record.title,
        canonicalUrl: record.canonicalUrl,
        articleContentHash: record.contentHash,
        version,
        status: "validated",
        generationMode: "deterministic_placeholder",
        platforms: plan.selectedPlatforms,
        items,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        provenance: {
          taskHash: sha256(`${plan.id}:deterministic-renderer-v1`),
          importHash,
          importedAt: plan.updatedAt,
          importedBy: "manual",
        },
        warnings: quality.flatMap((report) => report.warnings),
        disclosures: [],
      });
      await this.d.packages.save(pkg, quality, {
        mode: "deterministic_renderer_v1",
        selectedPlatforms: plan.selectedPlatforms,
      });
      const assets: SocialAsset[] = [];
      for (const output of rendered)
        assets.push(await this.d.assets.save(output.asset, output.bytes));
      plan = socialDistributionPlanSchema.parse({
        ...plan,
        packageId,
        packageVersion: version,
        status: blocked.size ? "blocked" : "ready_for_confirmation",
        platformStates: plan.selectedPlatforms.map((platform) => ({
          ...this.initialPlatform(platform),
          state: blocked.has(platform) ? "blocked" : "prepared",
          itemIds: items
            .filter((item) => item.platform === platform)
            .map((item) => item.id),
          assetIds: assets
            .filter((asset) => asset.platform === platform)
            .map((asset) => asset.id),
          warnings: quality
            .filter((report) => report.platform === platform)
            .flatMap((report) => [
              ...report.blockingIssues,
              ...report.warnings,
            ]),
        })),
        version: plan.version + 1,
        updatedAt: this.now(),
      });
      await this.d.plans.save(plan);
      await this.event(plan, "prepared");
      return this.status(plan.id);
    } catch (error) {
      plan = socialDistributionPlanSchema.parse({
        ...plan,
        status: "failed",
        platformStates: plan.platformStates.map((state) => ({
          ...state,
          state: "failed",
          error:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : "Preparation failed",
        })),
        version: plan.version + 1,
        updatedAt: this.now(),
      });
      await this.d.plans.save(plan);
      await this.event(plan, "failed");
      throw error;
    }
  }

  async confirm(planId: string, callback?: CallbackContext) {
    let plan = await this.required(planId);
    if (["manual_ready", "completed"].includes(plan.status))
      return this.status(plan.id);
    if (plan.status === "blocked")
      throw new Error(
        "A blocking platform item requires review before confirmation",
      );
    if (
      !["ready_for_confirmation", "approved"].includes(plan.status) ||
      !plan.packageVersion
    )
      throw new Error("Distribution plan is not ready for confirmation");
    const replay = await this.isReplay(plan.id, callback);
    if (!replay && !(await this.event(plan, "confirmed", undefined, callback)))
      return this.status(plan.id);

    for (const platform of plan.selectedPlatforms)
      await this.d.social.approve(
        plan.publicationId,
        platform,
        plan.packageVersion,
        "approve",
        {
          telegramUpdateId: callback?.telegramUpdateId,
          callbackQueryId: callback?.callbackQueryId
            ? `${callback.callbackQueryId}:${platform}`
            : undefined,
        },
      );

    if (plan.status !== "approved") {
      plan = socialDistributionPlanSchema.parse({
        ...plan,
        status: "approved",
        version: plan.version + 1,
        updatedAt: this.now(),
      });
      await this.d.plans.save(plan);
    }

    const pkg = await this.d.packages.get(
      plan.publicationId,
      plan.packageVersion,
    );
    if (!pkg) throw new Error("Prepared social package disappeared");
    const assets = await this.currentAssets(plan);
    const platformStates = [];
    let allPosted = true;
    for (const platform of plan.selectedPlatforms) {
      const publisher = this.d.publishers.for(platform);
      const capability = publisher.capabilities();
      if (!capability.canAutoPost || !publisher.isConfigured()) {
        allPosted = false;
        platformStates.push({
          ...this.initialPlatform(platform),
          state: "manual_ready" as const,
          itemIds: pkg.items
            .filter((item) => item.platform === platform)
            .map((item) => item.id),
          assetIds: assets
            .filter((asset) => asset.platform === platform)
            .map((asset) => asset.id),
          warnings: [],
        });
        continue;
      }
      const result = await publisher.publish({
        idempotencyKey: sha256(`${plan.id}:${platform}:${plan.packageVersion}`),
        platform,
        items: pkg.items.filter((item) => item.platform === platform),
        assets: assets.filter((asset) => asset.platform === platform),
      });
      if (!result.confirmed || !result.postUrl)
        throw new Error(`${platform} provider did not confirm publication`);
      const primary = pkg.items.find((item) => item.platform === platform);
      await this.d.social.recordProviderPost(
        plan.publicationId,
        platform,
        result.postUrl,
        publisher.id,
        { version: plan.packageVersion, itemId: primary?.id },
      );
      platformStates.push({
        ...this.initialPlatform(platform),
        state: "posted" as const,
        postUrl: result.postUrl,
        itemIds: pkg.items
          .filter((item) => item.platform === platform)
          .map((item) => item.id),
        assetIds: assets
          .filter((asset) => asset.platform === platform)
          .map((asset) => asset.id),
        warnings: [],
      });
    }
    const confirmedAt = this.now();
    plan = socialDistributionPlanSchema.parse({
      ...plan,
      status: allPosted ? "completed" : "manual_ready",
      platformStates,
      confirmedAt,
      version: plan.version + 1,
      updatedAt: confirmedAt,
    });
    await this.d.plans.save(plan);
    await this.writeManifest(plan, pkg.items.length, assets);
    await this.event(plan, allPosted ? "posted" : "manual_ready");
    return this.status(plan.id);
  }

  async cancel(planId: string, skip = false, callback?: CallbackContext) {
    const plan = await this.required(planId);
    if (["completed", "cancelled", "skipped"].includes(plan.status))
      return plan;
    const next = socialDistributionPlanSchema.parse({
      ...plan,
      status: skip ? "skipped" : "cancelled",
      version: plan.version + 1,
      updatedAt: this.now(),
    });
    if (
      !(await this.event(
        next,
        skip ? "skipped" : "cancelled",
        undefined,
        callback,
      ))
    )
      return this.required(planId);
    await this.d.plans.save(next);
    return next;
  }

  async status(planId: string) {
    const plan = await this.required(planId);
    const assets = await this.currentAssets(plan);
    return {
      plan,
      capabilities: Object.fromEntries(
        platforms.map((platform) => [
          platform,
          this.d.publishers.capabilities(platform),
        ]),
      ),
      assets,
      quality: plan.packageVersion
        ? await this.d.social.quality(plan.publicationId, plan.packageVersion)
        : [],
      exports: plan.packageVersion
        ? await this.d.exports.list(plan.publicationId, plan.packageVersion)
        : [],
      exportBundleLocation: this.exportBundleLocation(plan),
    };
  }

  getPlan(id: string) {
    return this.d.plans.get(id);
  }
  getPlanByPublication(publicationId: string) {
    return this.d.plans.getByPublication(publicationId);
  }
  getPlanByShortId(shortId: string) {
    return this.d.plans.getByShortId(shortId);
  }
  capabilities(platform: SocialPlatform) {
    return this.d.publishers.capabilities(platform);
  }

  exportBundleLocation(plan: SocialDistributionPlan) {
    return plan.packageVersion
      ? this.d.exports.location(plan.publicationId, plan.packageVersion)
      : undefined;
  }

  async materializeAssets(planId: string, outputDirectory: string) {
    const plan = await this.required(planId);
    if (!plan.packageVersion)
      throw new Error("Distribution assets have not been prepared");
    const root = resolve(outputDirectory);
    await mkdir(root, { recursive: true });
    const files = await this.d.exports.readFiles(
      plan.publicationId,
      plan.packageVersion,
    );
    for (const [name, body] of Object.entries(files)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
        throw new Error(`Unsafe social export filename: ${name}`);
      await writeFile(join(root, name), body, { mode: 0o600 });
    }
    const records = [];
    for (const asset of await this.currentAssets(plan)) {
      const bytes = await this.d.assets.read(asset.id);
      if (!bytes)
        throw new Error(`Social asset bytes are unavailable: ${asset.id}`);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== asset.contentHash)
        throw new Error(`Social asset hash mismatch: ${asset.id}`);
      const name = `${asset.platform}-${asset.kind}${asset.slideNumber ? `-${asset.slideNumber}` : ""}-${asset.id.slice(-8)}.png`;
      const path = join(root, name);
      await writeFile(path, bytes, { mode: 0o600 });
      records.push({ ...asset, path });
    }
    const manifestPath = join(root, "asset-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          planId: plan.id,
          publicationId: plan.publicationId,
          selectedPlatforms: plan.selectedPlatforms,
          assets: records,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return {
      outputDirectory: root,
      manifestPath,
      files: Object.keys(files).sort(),
      assets: records,
    };
  }

  private initialPlatform(platform: SocialPlatform) {
    const publisher = this.d.publishers.for(platform);
    return {
      platform,
      state: "selected" as const,
      provider: publisher.id,
      capabilities: publisher.capabilities(),
      itemIds: [],
      assetIds: [],
      warnings: [],
    };
  }

  private async required(planId: string) {
    const plan = await this.d.plans.get(planId);
    if (!plan) throw new Error("Social distribution plan not found");
    return plan;
  }

  private async currentAssets(plan: SocialDistributionPlan) {
    if (!plan.packageVersion) return [];
    const pkg = await this.d.packages.get(
      plan.publicationId,
      plan.packageVersion,
    );
    if (!pkg) return [];
    const referenced = new Set(
      pkg.items.flatMap((item) => item.assetIds ?? []),
    );
    return (await this.d.assets.list(plan.id))
      .filter((asset) => referenced.has(asset.id))
      .map((asset) => ({
        ...asset,
        altText: currentAltText(pkg.items, asset) ?? asset.altText,
      }));
  }

  private async isReplay(planId: string, callback?: CallbackContext) {
    if (!callback) return false;
    return (await this.d.plans.listEvents(planId)).some(
      (event) => event.callbackQueryId === callback.callbackQueryId,
    );
  }

  private async event(
    plan: SocialDistributionPlan,
    type: SocialDistributionEvent["type"],
    platform?: SocialPlatform,
    callback?: CallbackContext,
  ) {
    const sequence = (await this.d.plans.listEvents(plan.id)).length + 1;
    const createdAt = this.now();
    return this.d.plans.appendEvent(
      socialDistributionEventSchema.parse({
        id: `socialevent_${sha256(`${plan.id}:${callback?.callbackQueryId ?? `${type}:${sequence}`}`).slice(0, 24)}`,
        planId: plan.id,
        sequence,
        type,
        platform,
        telegramUpdateId: callback?.telegramUpdateId,
        callbackQueryId: callback?.callbackQueryId,
        actorUserId: callback?.actorUserId,
        planVersion: plan.version,
        selectedPlatforms: plan.selectedPlatforms,
        planStatus: plan.status,
        snapshotHash: sha256(JSON.stringify(plan)),
        createdAt,
      }),
    );
  }

  private async writeManifest(
    plan: SocialDistributionPlan,
    itemCount: number,
    assets: Awaited<ReturnType<SocialAssetRepository["list"]>>,
  ) {
    if (!plan.packageId || !plan.packageVersion) return;
    const body = `${JSON.stringify(
      {
        planId: plan.id,
        publicationId: plan.publicationId,
        packageId: plan.packageId,
        packageVersion: plan.packageVersion,
        selectedPlatforms: plan.selectedPlatforms,
        providerMode: "manual",
        itemCount,
        assets: assets.map((asset) => ({
          platform: asset.platform,
          kind: asset.kind,
          width: asset.width,
          height: asset.height,
          path: asset.path,
          altText: asset.altText,
          contentHash: asset.contentHash,
        })),
      },
      null,
      2,
    )}\n`;
    const now = this.now();
    await this.d.exports.write(
      plan.publicationId,
      plan.packageVersion,
      { "distribution-manifest.json": body },
      plan.selectedPlatforms.map((platform) =>
        socialExportSchema.parse({
          id: `socialexport_${sha256(`${plan.id}:manifest:${platform}`).slice(0, 24)}`,
          packageId: plan.packageId,
          packageVersion: plan.packageVersion,
          platform,
          format: "json",
          path: "distribution-manifest.json",
          contentHash: digest(body),
          createdAt: now,
        }),
      ),
    );
  }
}

interface CallbackContext {
  telegramUpdateId: number;
  callbackQueryId: string;
  actorUserId: string;
}

function orderPlatforms(a: SocialPlatform, b: SocialPlatform) {
  return platforms.indexOf(a) - platforms.indexOf(b);
}

function currentAltText(items: PlatformContentItem[], asset: SocialAsset) {
  const item = items.find(
    (value) =>
      value.platform === asset.platform && value.assetIds?.includes(asset.id),
  );
  if (!item) return undefined;
  if (asset.kind === "carousel_slide" && asset.slideNumber)
    return item.slides?.find((slide) => slide.slideNumber === asset.slideNumber)
      ?.altText;
  return item.altText;
}
