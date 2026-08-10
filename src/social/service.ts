import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  ContentRepository,
  ProductionPublicationArtifactRepository,
} from "../publication/interfaces";
import type { ProductionPublicationArtifact } from "../publication/models";
import { digest, publicSourceUrl } from "../publication/transform";
import { sha256 } from "../writing/task";
import type { SocialConfig } from "./config";
import type {
  SocialApprovalRepository,
  SocialExportRepository,
  SocialGenerationJobRepository,
  SocialHistoryRepository,
  SocialPackageRepository,
  SocialPostedRepository,
  SocialQualityRepository,
  SocialRevisionRepository,
  SocialTaskRepository,
} from "./interfaces";
import {
  importedSocialResultSchema,
  platformContentItemSchema,
  postedRecordSchema,
  socialApprovalSchema,
  socialExportSchema,
  socialHistorySchema,
  socialJobSchema,
  socialPackageSchema,
  socialRevisionSchema,
  type PlatformContentItem,
  type SocialPackage,
  type SocialPlatform,
} from "./models";
import { contentHash, scrubSocial, validateSocialItem } from "./quality";
import { buildSocialTask, createClaimIndex, publicArticleText } from "./task";

export interface SocialDependencies {
  publications: ProductionPublicationArtifactRepository;
  content: ContentRepository;
  jobs: SocialGenerationJobRepository;
  packages: SocialPackageRepository;
  quality: SocialQualityRepository;
  tasks: SocialTaskRepository;
  approvals: SocialApprovalRepository;
  history: SocialHistoryRepository;
  exports: SocialExportRepository;
  posted: SocialPostedRepository;
  revisions: SocialRevisionRepository;
  config: SocialConfig;
  paths: {
    prompt: string;
    audience: string;
    writing: string;
    editorial: string;
    design: string;
  };
  clock?: () => Date;
}

export class SocialService {
  constructor(private d: SocialDependencies) {}
  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }

  async prepare(
    publicationId: string,
    platforms?: SocialPlatform[],
    workerId = "social-worker",
    revision?: unknown,
  ) {
    const record = await this.record(publicationId);
    const mdx = await this.article(record);
    const selected = [...new Set(platforms ?? this.d.config.defaultPlatforms)];
    if (
      !selected.length ||
      selected.some((x) => !this.d.config.enabledPlatforms.includes(x))
    )
      throw new Error("Platform selection is empty or disabled");
    let job = await this.d.jobs.claim(
      record,
      workerId,
      this.now().toISOString(),
    );
    if (job.articleContentHash !== record.contentHash)
      throw new Error("Active social job targets a stale publication hash");
    if (
      job.status === "awaiting_manual_generation" &&
      job.taskHash &&
      job.packageVersion &&
      samePlatforms(job.selectedPlatforms ?? [], selected)
    )
      return {
        publicationId,
        packageId: job.packageId,
        packageVersion: job.packageVersion,
        platforms: selected,
        taskHash: job.taskHash,
        taskDirectory: `data/tasks/social/${publicationId}/v${job.packageVersion}`,
        reused: true,
        warnings: this.historyWarnings(record, await this.d.history.list()),
      };
    const version = await this.d.packages.nextVersion(publicationId);
    const brand = {
      audience: await readFile(this.d.paths.audience, "utf8"),
      writing: await readFile(this.d.paths.writing, "utf8"),
      editorial: await readFile(this.d.paths.editorial, "utf8"),
      design: await readFile(this.d.paths.design, "utf8"),
    };
    const task = buildSocialTask({
      record,
      mdx,
      platforms: selected,
      version,
      config: this.d.config,
      brand,
      prompt: await readFile(this.d.paths.prompt, "utf8"),
      now: this.now(),
      revision,
    });
    const files: Record<string, string> = {
      ...task.files,
      "expected-output.schema.json": `${JSON.stringify(z.toJSONSchema(importedSocialResultSchema), null, 2)}\n`,
    };
    if (this.d.config.imagePromptsEnabled)
      files["image-prompts.json"] = `${JSON.stringify(
        {
          instruction: "Return safe text prompts only; do not generate images",
          requiredNegativeInstructions: [
            "no fake official screenshots",
            "no fabricated unreleased hardware",
            "no implied hands-on possession",
            "no unauthorized logos",
            "no unlicensed third-party screenshots",
            "no text inside images unless explicitly designed",
          ],
        },
        null,
        2,
      )}\n`;
    const path = await this.d.tasks.write(publicationId, version, files);
    job = socialJobSchema.parse({
      ...job,
      status: "awaiting_manual_generation",
      taskHash: task.taskHash,
      selectedPlatforms: selected,
      packageVersion: version,
      packageId: `socialpackage_${sha256(publicationId).slice(0, 24)}`,
      heartbeatAt: this.now().toISOString(),
      version: job.version + 1,
    });
    await this.d.jobs.save(job);
    return {
      publicationId,
      packageId: job.packageId,
      packageVersion: version,
      platforms: selected,
      taskHash: task.taskHash,
      taskDirectory: path,
      reused: false,
      warnings: this.historyWarnings(record, await this.d.history.list()),
    };
  }

  async import(publicationId: string, file: string) {
    return this.importValue(
      publicationId,
      JSON.parse(await readFile(file, "utf8")) as unknown,
    );
  }

  async importValue(
    publicationId: string,
    raw: unknown,
    revisionFrom?: number,
  ) {
    const record = await this.record(publicationId);
    const mdx = await this.article(record);
    let job = await this.d.jobs.get(publicationId);
    if (!job?.taskHash || !job.packageVersion || !job.selectedPlatforms)
      throw new Error("Social task was not prepared");
    const parsed = importedSocialResultSchema.parse(raw);
    if (
      parsed.publicationId !== publicationId ||
      parsed.articleContentHash !== record.contentHash ||
      parsed.packageVersion !== job.packageVersion ||
      parsed.provenance.taskHash !== job.taskHash
    )
      throw new Error(
        "Social import does not match the exact task and publication",
      );
    if (!samePlatforms(parsed.platforms, job.selectedPlatforms))
      throw new Error("Imported platform selection changed");
    const importHash = sha256(JSON.stringify(parsed));
    const duplicate = await this.d.packages.findByImportHash(importHash);
    if (duplicate)
      return {
        pkg: this.summary(duplicate),
        quality: await this.d.quality.get(publicationId, duplicate.version),
        reused: true,
      };
    const version = await this.d.packages.nextVersion(publicationId);
    if (version !== parsed.packageVersion)
      throw new Error("Social package version is stale");
    const now = this.now().toISOString();
    const packageId = `socialpackage_${sha256(publicationId).slice(0, 24)}`;
    const claims = createClaimIndex(mdx);
    const seen = new Set<string>();
    const items = parsed.items.map((item) => {
      if (!parsed.platforms.includes(item.platform))
        throw new Error("Item uses an unselected platform");
      const stable = sha256(
        JSON.stringify({
          publicationId,
          platform: item.platform,
          contentType: item.contentType,
          content: item,
        }),
      ).slice(0, 24);
      const value = platformContentItemSchema.parse({
        ...item,
        id: `socialitem_${stable}`,
        status: "draft",
        characterCount: itemText(item).length,
        warnings: [],
        createdAt: now,
        updatedAt: now,
      });
      const fingerprint = contentHash(value);
      if (seen.has(fingerprint))
        throw new Error("Duplicate social content item");
      seen.add(fingerprint);
      return value;
    });
    if (revisionFrom) {
      const request = await this.d.revisions.get(publicationId, revisionFrom);
      const old = await this.d.packages.get(publicationId, revisionFrom);
      if (!request || !old) throw new Error("Revision source is unavailable");
      for (const previous of old.items) {
        const current = items.find(
          (x) =>
            x.platform === previous.platform &&
            x.contentType === previous.contentType,
        );
        if (
          !current ||
          (!scopeAllows(request.scope, previous.contentType) &&
            revisionFingerprint(current, request.scope) !==
              revisionFingerprint(previous, request.scope))
        )
          throw new Error("Social revision changed content outside its scope");
      }
    }
    for (const prompt of parsed.imagePrompts) {
      scrubSocial(JSON.stringify(prompt));
      if (
        !prompt.negativeInstructions.some((x) =>
          /fake|fabricat|possession|screenshot|logo/i.test(x),
        )
      )
        throw new Error("Image prompt lacks misinformation safeguards");
    }
    const commercialRelationship =
      /\b(?:sponsor(?:ed|ship)?|affiliate|paid partnership|free review sample|employer relationship)\b/i.test(
        publicArticleText(mdx),
      );
    if (commercialRelationship && !parsed.disclosures.length)
      throw new Error(
        "Published commercial relationship requires platform disclosures",
      );
    for (const disclosure of parsed.disclosures) {
      scrubSocial(disclosure.statement);
      if (!claims.some((claim) => claim.id === disclosure.claimReference))
        throw new Error("Disclosure references an unknown published claim");
    }
    const quality = items.map((item) =>
      validateSocialItem(item, {
        canonicalUrl: record.canonicalUrl,
        articleText: publicArticleText(mdx),
        claims,
        config: this.d.config,
        now,
        packageId,
        packageVersion: version,
        requiredDisclosures: parsed.disclosures
          .filter((value) => value.platforms.includes(item.platform))
          .map((value) => value.statement),
      }),
    );
    if (quality.some((x) => x.status === "blocked")) {
      job = socialJobSchema.parse({
        ...job,
        status: "blocked",
        failureCode: "social_validation_failed",
        failureMessage:
          "One or more platform items failed deterministic validation",
        heartbeatAt: now,
        version: job.version + 1,
      });
      await this.d.jobs.save(job);
      throw new Error(
        `Social import failed deterministic quality validation: ${quality
          .flatMap((x) => x.blockingIssues)
          .filter((x, index, all) => all.indexOf(x) === index)
          .join("; ")}`,
      );
    }
    const previous = await this.d.packages.get(publicationId);
    const pkg = socialPackageSchema.parse({
      id: packageId,
      publicationId,
      topicId: record.topicId,
      articleSlug: record.slug,
      articleTitle: record.title,
      canonicalUrl: record.canonicalUrl,
      articleContentHash: record.contentHash,
      version,
      status: "validated",
      generationMode: parsed.provenance.mode,
      platforms: parsed.platforms,
      items,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      supersedesVersion:
        revisionFrom ?? (version > 1 ? version - 1 : undefined),
      provenance: {
        taskHash: job.taskHash,
        importHash,
        importedAt: now,
        importedBy: "manual",
      },
      warnings: quality.flatMap((x) => x.warnings),
      disclosures: parsed.disclosures,
    });
    await this.d.packages.save(pkg, quality, {
      importHash,
      generatorNotes: parsed.generatorNotes,
      unresolvedQuestions: parsed.unresolvedQuestions,
      visualBriefs: parsed.visualBriefs,
      imagePrompts: parsed.imagePrompts,
      timingSuggestions: parsed.timingSuggestions,
    });
    job = socialJobSchema.parse({
      ...job,
      status: "ready_for_social_approval",
      packageId,
      completedAt: now,
      heartbeatAt: now,
      version: job.version + 1,
    });
    await this.d.jobs.save(job);
    if (revisionFrom) await this.preserveApprovals(pkg, revisionFrom);
    return { pkg: this.summary(pkg), quality, reused: false };
  }

  async approve(
    publicationId: string,
    platform: SocialPlatform,
    version: number,
    action: "approve" | "schedule" | "request_changes" | "reject" | "hold",
    options: {
      publishAt?: string;
      notes?: string[];
      changes?: string[];
      telegramUpdateId?: number;
      callbackQueryId?: string;
      itemId?: string;
    } = {},
  ) {
    const record = await this.record(publicationId);
    const pkg = await this.d.packages.get(publicationId, version);
    if (!pkg || pkg.articleContentHash !== record.contentHash)
      throw new Error("Exact social package version is unavailable or stale");
    const quality = await this.d.quality.get(publicationId, version);
    const items = pkg.items.filter(
      (x) =>
        x.platform === platform && (!options.itemId || x.id === options.itemId),
    );
    if (!items.length) throw new Error("Platform is absent from package");
    const schedule =
      action === "schedule"
        ? this.normalizeSchedule(options.publishAt)
        : undefined;
    const out = [];
    for (const item of items) {
      const q = quality.find((x) => x.platformItemId === item.id);
      if (!q || q.status === "blocked")
        throw new Error("Platform item quality blocks approval");
      const old = await this.d.approvals.get(pkg.id, item.id);
      if (
        old?.callbackQueryId &&
        old.callbackQueryId === options.callbackQueryId
      ) {
        out.push(old);
        continue;
      }
      const now = this.now().toISOString();
      const status = {
        approve: "approved",
        schedule: "scheduled",
        request_changes: "changes_requested",
        reject: "rejected",
        hold: "held",
      }[action];
      const value = socialApprovalSchema.parse({
        id:
          old?.id ??
          `socialapproval_${sha256(`${pkg.id}:${item.id}`).slice(0, 24)}`,
        packageId: pkg.id,
        packageVersion: version,
        platformItemId: item.id,
        platform,
        action,
        status,
        approvalNotes: options.notes ?? [],
        requestedChanges: options.changes ?? [],
        scheduledAt: schedule,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        telegramUpdateId: options.telegramUpdateId ?? 0,
        callbackQueryId: options.callbackQueryId,
        version: (old?.version ?? 0) + 1,
      });
      await this.d.approvals.save(value);
      out.push(value);
      if (["approve", "schedule"].includes(action))
        await this.d.history.add(
          socialHistorySchema.parse({
            publicationId,
            platform,
            hook: itemText(item).split("\n")[0]?.slice(0, 300) ?? "",
            mainAngle: item.claimReferences.join(","),
            entities: [],
            keywords: item.hashtags,
            contentHash: contentHash(item),
            approvedDate: action === "approve" ? now : undefined,
            scheduledDate: schedule,
            status: action === "approve" ? "approved" : "scheduled",
          }),
        );
    }
    if (["approve", "schedule"].includes(action))
      await this.export(publicationId, version);
    return out;
  }

  async export(publicationId: string, version: number) {
    const pkg = await this.d.packages.get(publicationId, version);
    if (!pkg) throw new Error("Social package not found");
    const approvals = await this.d.approvals.list(pkg.id);
    const files: Record<string, string> = {};
    const records = [];
    const now = this.now().toISOString();
    for (const item of pkg.items) {
      const approval = approvals.find(
        (x) => x.platformItemId === item.id && x.packageVersion === version,
      );
      if (
        !approval ||
        !["approved", "scheduled", "posted_manually"].includes(approval.status)
      )
        continue;
      for (const [name, body] of Object.entries(
        exportItem(item, pkg.canonicalUrl),
      )) {
        scrubSocial(body);
        files[name] = body;
        records.push(
          socialExportSchema.parse({
            id: `socialexport_${sha256(`${pkg.id}:${version}:${name}`).slice(0, 24)}`,
            packageId: pkg.id,
            packageVersion: version,
            platform: item.platform,
            format: name.endsWith(".json")
              ? "json"
              : name.endsWith(".md")
                ? "markdown"
                : "text",
            path: name,
            contentHash: digest(body),
            createdAt: now,
          }),
        );
      }
    }
    const schedule = approvals
      .filter((x) => x.packageVersion === version && x.status === "scheduled")
      .map((x) => ({
        platform: x.platform,
        publishAt: x.scheduledAt,
        timezone: this.d.config.timezone,
        nativeSchedulingConfirmed: false,
      }));
    if (schedule.length)
      files["schedule.json"] = `${JSON.stringify(schedule, null, 2)}\n`;
    return this.d.exports.write(publicationId, version, files, records);
  }

  async prepareRevision(
    publicationId: string,
    version: number,
    scope: z.infer<typeof socialRevisionSchema>["scope"],
    instruction: string,
  ) {
    const pkg = await this.d.packages.get(publicationId, version);
    if (!pkg) throw new Error("Package not found");
    if (version >= this.d.config.maximumRevisions + 1)
      throw new Error("Maximum social revision count reached");
    const claims = createClaimIndex(
      await this.article(await this.record(publicationId)),
    );
    const createdAt = this.now().toISOString();
    const taskHash = sha256(
      JSON.stringify({
        publicationId,
        version,
        scope,
        instruction,
        claims: claims.map((x) => x.fingerprint),
      }),
    );
    const request = socialRevisionSchema.parse({
      publicationId,
      sourcePackageVersion: version,
      scope,
      instruction,
      protectedClaimIds: claims.map((x) => x.id),
      createdAt,
      taskHash,
    });
    const path = await this.d.revisions.write(
      publicationId,
      version,
      {
        "social-revision.md": `# Social revision\n\nChange only scope: ${scope}. ${instruction}\nPreserve protected claims. Do not browse, post, or generate images. Return strict JSON only.\nTask hash: ${taskHash}\n`,
        "revision-input.json": `${JSON.stringify({ package: this.summary(pkg), scope, instruction }, null, 2)}\n`,
        "expected-output.schema.json": `${JSON.stringify(z.toJSONSchema(importedSocialResultSchema), null, 2)}\n`,
        "protected-claims.json": `${JSON.stringify(claims, null, 2)}\n`,
      },
      request,
    );
    const job = await this.d.jobs.get(publicationId);
    if (!job) throw new Error("Social job missing");
    const next = await this.d.packages.nextVersion(publicationId);
    await this.d.jobs.save(
      socialJobSchema.parse({
        ...job,
        status: "awaiting_manual_generation",
        taskHash,
        packageVersion: next,
        selectedPlatforms: pkg.platforms,
        heartbeatAt: createdAt,
        version: job.version + 1,
      }),
    );
    return { request, taskDirectory: path, nextPackageVersion: next };
  }

  async importRevision(
    publicationId: string,
    sourceVersion: number,
    file: string,
  ) {
    if (!(await this.d.revisions.get(publicationId, sourceVersion)))
      throw new Error("Revision task not found");
    return this.importValue(
      publicationId,
      JSON.parse(await readFile(file, "utf8")) as unknown,
      sourceVersion,
    );
  }

  async markPosted(
    publicationId: string,
    platform: SocialPlatform,
    postUrl: string,
    options: { itemId?: string; version?: number } = {},
  ) {
    return this.recordPosted(publicationId, platform, postUrl, {
      ...options,
      method: "manual",
      provider: "manual",
    });
  }

  async recordProviderPost(
    publicationId: string,
    platform: SocialPlatform,
    postUrl: string,
    provider: string,
    options: { itemId?: string; version?: number } = {},
  ) {
    return this.recordPosted(publicationId, platform, postUrl, {
      ...options,
      method: "api",
      provider,
    });
  }

  private async recordPosted(
    publicationId: string,
    platform: SocialPlatform,
    postUrl: string,
    options: {
      itemId?: string;
      version?: number;
      method: "manual" | "api";
      provider: string;
    },
  ) {
    await this.record(publicationId);
    const pkg = await this.d.packages.get(publicationId, options.version);
    if (!pkg) throw new Error("Social package not found");
    const candidates = pkg.items.filter(
      (x) =>
        x.platform === platform && (!options.itemId || x.id === options.itemId),
    );
    if (candidates.length > 1)
      throw new Error(
        "Platform has multiple items; use an exact Telegram item action",
      );
    const item = candidates[0];
    if (!item) throw new Error("Platform item not found");
    const approval = await this.d.approvals.get(pkg.id, item.id);
    if (!approval || !["approved", "scheduled"].includes(approval.status))
      throw new Error("Platform item is not approved for manual posting");
    const safe = publicSourceUrl(postUrl, true);
    if (safe !== postUrl || !validPostHost(platform, new URL(safe).hostname))
      throw new Error("Invalid public platform post URL");
    const now = this.now().toISOString();
    const posted = postedRecordSchema.parse({
      publicationId,
      packageId: pkg.id,
      packageVersion: pkg.version,
      platform,
      platformItemId: item.id,
      postUrl: safe,
      postedAt: now,
      method: options.method,
      provider: options.provider,
      contentHash: contentHash(item),
      verificationState:
        options.method === "api" ? "api_confirmed" : "operator_confirmed",
    });
    await this.d.posted.save(posted);
    await this.d.approvals.save(
      socialApprovalSchema.parse({
        ...approval,
        action: "mark_posted",
        status: options.method === "api" ? "posted" : "posted_manually",
        updatedAt: now,
        version: approval.version + 1,
      }),
    );
    await this.d.history.add(
      socialHistorySchema.parse({
        publicationId,
        platform,
        hook: itemText(item).split("\n")[0]?.slice(0, 300) ?? "",
        mainAngle: item.claimReferences.join(","),
        entities: [],
        keywords: item.hashtags,
        contentHash: contentHash(item),
        postedDate: now,
        status: options.method === "api" ? "posted" : "posted_manually",
        postUrl: safe,
      }),
    );
    return posted;
  }

  async status(publicationId: string) {
    const job = await this.d.jobs.get(publicationId);
    const pkg = await this.d.packages.get(publicationId);
    return {
      job,
      pkg: pkg ? this.summary(pkg) : undefined,
      quality: pkg ? await this.d.quality.get(publicationId, pkg.version) : [],
      approvals: pkg ? await this.d.approvals.list(pkg.id) : [],
      exports: pkg ? await this.d.exports.list(publicationId, pkg.version) : [],
    };
  }
  async package(publicationId: string, version?: number) {
    const pkg = await this.d.packages.get(publicationId, version);
    return pkg ? this.summary(pkg) : undefined;
  }
  getPackageRecord(publicationId: string, version?: number) {
    return this.d.packages.get(publicationId, version);
  }
  getEligiblePublication(publicationId: string) {
    return this.record(publicationId);
  }
  async getPublishedArticle(publicationId: string) {
    const record = await this.record(publicationId);
    return { record, mdx: await this.article(record) };
  }
  async quality(publicationId: string, version?: number) {
    const pkg = await this.d.packages.get(publicationId, version);
    return pkg ? this.d.quality.get(publicationId, pkg.version) : [];
  }

  private async record(id: string) {
    const record = await this.d.publications.getById(id);
    if (!record)
      throw new Error("Exact verified production publication ID not found");
    if (
      record.status !== "published" ||
      record.deploymentProvider !== "vercel_git" ||
      record.deploymentStatus !== "ready" ||
      record.deploymentEnvironment !== "production" ||
      record.contentHash !== record.expectedContentHash
    )
      throw new Error(
        "Production publication is not eligible for social generation",
      );
    const latest = (await this.d.publications.list())
      .filter(
        (value) => value.sourcePublicationId === record.sourcePublicationId,
      )
      .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
    if (
      !latest ||
      latest.id !== id ||
      latest.contentHash !== record.contentHash
    )
      throw new Error("Production publication was superseded");
    return record;
  }
  private async article(record: ProductionPublicationArtifact) {
    const file = await this.d.content.getFile(
      record.articlePath,
      record.commitSha,
    );
    if (!file) throw new Error("Published article blob is unavailable");
    if (digest(file.content) !== record.contentHash)
      throw new Error("Published article content hash mismatch");
    if (!file.content.includes(record.canonicalUrl))
      throw new Error("Published canonical URL is missing from the article");
    return file.content;
  }
  private summary(pkg: SocialPackage) {
    return {
      id: pkg.id,
      publicationId: pkg.publicationId,
      version: pkg.version,
      status: pkg.status,
      articleTitle: pkg.articleTitle,
      canonicalUrl: pkg.canonicalUrl,
      platforms: pkg.platforms,
      items: pkg.items.map((x) => ({
        id: x.id,
        platform: x.platform,
        contentType: x.contentType,
        status: x.status,
        characterCount: x.characterCount,
        warnings: x.warnings.length,
      })),
    };
  }
  private normalizeSchedule(value?: string) {
    if (!value) throw new Error("A schedule time is required");
    const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? value
      : `${value}:00-07:00`;
    const date = new Date(normalized);
    if (!Number.isFinite(date.valueOf()) || date <= this.now())
      throw new Error("Schedule time must be valid and in the future");
    return date.toISOString();
  }
  private historyWarnings(
    record: ProductionPublicationArtifact,
    history: Awaited<ReturnType<SocialHistoryRepository["list"]>>,
  ) {
    return history.some((x) => x.publicationId === record.id)
      ? [
          "This article already has social history; avoid repeated hooks and frequent promotion.",
        ]
      : [];
  }
  private async preserveApprovals(pkg: SocialPackage, oldVersion: number) {
    const old = await this.d.packages.get(pkg.publicationId, oldVersion);
    if (!old) return;
    for (const item of pkg.items) {
      const previous = old.items.find(
        (x) =>
          x.platform === item.platform &&
          x.contentType === item.contentType &&
          contentHash(x) === contentHash(item),
      );
      if (!previous) continue;
      const approval = await this.d.approvals.get(pkg.id, previous.id);
      if (approval && ["approved", "scheduled"].includes(approval.status))
        await this.d.approvals.save(
          socialApprovalSchema.parse({
            ...approval,
            platformItemId: item.id,
            packageVersion: pkg.version,
            updatedAt: this.now().toISOString(),
            version: approval.version + 1,
          }),
        );
    }
  }
}

function itemText(item: Partial<PlatformContentItem>) {
  return [
    item.title,
    item.text,
    ...(item.thread ?? []),
    ...(item.slides ?? []).flatMap((x) => [x.headline, x.body]),
  ]
    .filter(Boolean)
    .join("\n");
}
function samePlatforms(a: SocialPlatform[], b: SocialPlatform[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
function validPostHost(platform: SocialPlatform, host: string) {
  return {
    linkedin: ["linkedin.com", "www.linkedin.com"],
    x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    instagram: ["instagram.com", "www.instagram.com"],
    medium: ["medium.com", "www.medium.com"],
  }[platform].includes(host.toLowerCase());
}
function scopeAllows(
  scope: z.infer<typeof socialRevisionSchema>["scope"],
  contentType: PlatformContentItem["contentType"],
) {
  if (scope === "full_package") return true;
  if (scope === "timing_only" || scope === "visual_brief_only") return false;
  return {
    linkedin_only: ["linkedin_post"],
    x_post_only: ["x_post"],
    x_thread_only: ["x_thread"],
    instagram_carousel_only: ["instagram_carousel"],
    instagram_caption_only: ["instagram_caption"],
    medium_only: ["medium_adaptation"],
  }[scope].includes(contentType);
}
function revisionFingerprint(
  item: PlatformContentItem,
  scope: z.infer<typeof socialRevisionSchema>["scope"],
) {
  const comparable: Record<string, unknown> = { ...item };
  // Import-derived identifiers and timestamps are not editorial changes.
  delete comparable.id;
  delete comparable.status;
  delete comparable.characterCount;
  delete comparable.warnings;
  delete comparable.createdAt;
  delete comparable.updatedAt;
  if (scope === "timing_only") {
    delete comparable.suggestedPublishAt;
    delete comparable.timezone;
  }
  if (scope === "visual_brief_only") delete comparable.visualBrief;
  return sha256(JSON.stringify(comparable));
}
function exportItem(item: PlatformContentItem, canonical: string) {
  if (item.platform === "linkedin")
    return {
      "linkedin.txt": `${item.text ?? ""}\n`,
      "linkedin.md": `${item.text ?? ""}\n`,
      "linkedin.json": `${JSON.stringify({ platform: "linkedin", canonicalUrl: canonical, hashtags: item.hashtags }, null, 2)}\n`,
    };
  if (item.platform === "x")
    return item.contentType === "x_thread"
      ? {
          "x-thread.txt": `${(item.thread ?? []).join("\n\n---\n\n")}\n`,
          "x-thread.json": `${JSON.stringify({ platform: "x", posts: item.thread ?? [], canonicalUrl: canonical }, null, 2)}\n`,
        }
      : {
          "x-post.txt": `${item.text ?? ""}\n`,
          "x-post.json": `${JSON.stringify({ platform: "x", text: item.text ?? "", canonicalUrl: canonical }, null, 2)}\n`,
        };
  if (item.platform === "instagram")
    return item.contentType === "instagram_carousel"
      ? {
          "instagram-carousel.md": `${(item.slides ?? []).map((x) => `## Slide ${x.slideNumber}: ${x.headline}\n\n${x.body}\n\nVisual: ${x.visualDirection}\n\nAlt: ${x.altText}`).join("\n\n")}\n`,
          "instagram-alt-text.txt": `${(item.slides ?? []).map((x) => `Slide ${x.slideNumber}: ${x.altText}`).join("\n")}\n`,
          "instagram-visual-brief.json": `${JSON.stringify({ platform: "instagram", visualBrief: item.visualBrief ?? null, canonicalUrl: canonical }, null, 2)}\n`,
        }
      : { "instagram-caption.txt": `${item.text ?? ""}\n` };
  return {
    "medium-adaptation.md": `${item.title ? `# ${item.title}\n\n` : ""}${item.text ?? ""}\n\nOriginal publication: ${canonical}\n`,
    "medium-metadata.json": `${JSON.stringify({ platform: "medium", title: item.title, canonicalUrl: canonical, primaryPublication: true }, null, 2)}\n`,
  };
}
