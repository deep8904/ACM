import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ResearchPacketRepository } from "../research/interfaces";
import type { WritingConfig } from "./config";
import { assertWritingEligibility } from "./eligibility";
import { detectOverlap } from "./history";
import type {
  ArticleDraftRepository,
  ArticleHistoryRepository,
  DraftQualityRepository,
  WritingGateRepository,
  WritingJobRepository,
  WritingTaskRepository,
} from "./interfaces";
import { inspectMdx, renderFrontmatter, toPlainText } from "./mdx";
import {
  articleDraftSchema,
  articleHistoryEntrySchema,
  articleWritingResultSchema,
  draftClaimReferenceSchema,
  frontmatterSchema,
  writingJobSchema,
  type ArticleDraft,
  type WritingJob,
} from "./models";
import { evaluateDraft } from "./quality";
import { assertSafeSlug, createSlug } from "./slug";
import { createWritingTask, sha256, WRITING_PREPARATION_VERSION } from "./task";
import { selectArticleType } from "./article-type";

const taskInputSchema = z
  .object({
    topicId: z.string(),
    candidateId: z.string(),
    approvedEventId: z.string(),
    researchPacketId: z.string(),
    researchPacketVersion: z.number().int(),
    researchContentHashes: z.array(z.string()),
    articleType: z.string(),
    requestedSlug: z.string().optional(),
  })
  .passthrough();
export interface WritingPaths {
  prompt: string;
  audience: string;
  style: string;
  editorial: string;
  design: string;
  template: string;
}
export interface WritingServiceDependencies {
  packets: ResearchPacketRepository;
  jobs: WritingJobRepository;
  drafts: ArticleDraftRepository;
  quality: DraftQualityRepository;
  history: ArticleHistoryRepository;
  tasks: WritingTaskRepository;
  gates: WritingGateRepository;
  config: WritingConfig;
  configHash: string;
  paths: WritingPaths;
  clock?: () => Date;
  workerId?: string;
}

export class WritingService {
  constructor(private deps: WritingServiceDependencies) {}
  private now() {
    return (this.deps.clock ?? (() => new Date()))();
  }

  async prepare(
    topicId: string,
    researchVersion: number,
    requestedType?: string,
    slugOverride?: string,
  ) {
    if (!Number.isInteger(researchVersion) || researchVersion < 1)
      throw new Error(
        "An explicit positive research packet version is required",
      );
    const packet = await this.deps.packets.get(topicId, researchVersion);
    const event = packet
      ? await this.deps.gates.event(packet.approvedEventId)
      : undefined;
    const queue = await this.deps.gates.queue(topicId);
    const previousJob = await this.deps.jobs.get(topicId, researchVersion);
    try {
      assertWritingEligibility(packet, event, queue);
    } catch (error) {
      if (previousJob && gateWasCancelled(event, queue))
        await this.update(previousJob, {
          status: "cancelled",
          heartbeatAt: this.now().toISOString(),
        });
      throw error;
    }
    const type = selectArticleType(
      packet,
      requestedType,
      this.deps.config,
      this.now(),
    );
    const initialSlug = slugOverride
      ? assertSafeSlug(slugOverride, this.deps.config.slugMaxLength)
      : createSlug(packet.approvedTitle, this.deps.config.slugMaxLength);
    const overlap = await detectOverlap(
      this.deps.history,
      packet,
      packet.approvedTitle,
      initialSlug,
    );
    if (overlap.slugCollision)
      throw new Error("Generated slug collides with another topic");
    const latest = await this.deps.packets.get(topicId);
    if (latest && latest.version > researchVersion && latest.status === "ready")
      overlap.warnings.push(
        `A newer ready research packet v${latest.version} exists; this task remains pinned to v${researchVersion}`,
      );
    let job = await this.deps.jobs.claim(
      topicId,
      packet,
      type,
      this.deps.configHash,
      this.deps.workerId ?? `local-${process.pid}`,
      this.now().toISOString(),
    );
    if (!job) throw new Error("Could not claim writing job");
    if (
      job.researchPacketId !== packet.id ||
      job.articleType !== type ||
      job.researchContentHashes.join() !== packet.contentHashes.join()
    )
      throw new Error(
        "Existing active writing job conflicts with this request",
      );
    const existingTask = job.taskHash
      ? await this.deps.tasks.readInput(topicId, researchVersion)
      : undefined;
    const existingPreparationVersion =
      existingTask && typeof existingTask === "object"
        ? (existingTask as { preparationVersion?: unknown }).preparationVersion
        : undefined;
    if (
      job.status === "completed" ||
      (job.status === "awaiting_manual_writing" &&
        job.taskHash &&
        existingPreparationVersion === WRITING_PREPARATION_VERSION)
    )
      return {
        job,
        taskDirectory: `data/tasks/writing/${topicId}/v${researchVersion}`,
        overlap,
      };
    const now = this.now().toISOString();
    job = await this.update(job, { status: "preparing", heartbeatAt: now });
    const bundle = await createWritingTask(
      packet,
      type,
      overlap,
      this.deps.config,
      this.deps.paths,
      now,
      slugOverride,
    );
    const currentPacket = await this.deps.packets.get(topicId, researchVersion);
    const currentEvent = await this.deps.gates.event(packet.approvedEventId);
    const currentQueue = await this.deps.gates.queue(topicId);
    try {
      assertWritingEligibility(currentPacket, currentEvent, currentQueue);
    } catch (error) {
      if (gateWasCancelled(currentEvent, currentQueue))
        await this.update(job, { status: "cancelled", heartbeatAt: now });
      throw error;
    }
    const taskDirectory = await this.deps.tasks.write(
      topicId,
      researchVersion,
      bundle.files,
    );
    job = await this.update(job, {
      status: "awaiting_manual_writing",
      heartbeatAt: now,
      taskHash: bundle.taskHash,
    });
    return { job, taskDirectory, overlap };
  }

  async import(
    topicId: string,
    researchVersion: number,
    resultPath: string,
  ): Promise<{
    draft: ArticleDraft;
    quality: Awaited<ReturnType<DraftQualityRepository["get"]>>;
    reused: boolean;
  }> {
    const raw = await readFile(resultPath, "utf8");
    if (raw.length > this.deps.config.maxMdxCharacters * 2)
      throw new Error("Writing result exceeds the safe import size");
    const importHash = sha256(raw);
    const existing = await this.deps.drafts.findByImportHash(importHash);
    if (existing)
      return {
        draft: existing,
        quality: await this.deps.quality.get(
          existing.topicId,
          existing.version,
        ),
        reused: true,
      };
    const result = articleWritingResultSchema.parse(JSON.parse(raw));
    assertNoExecutableAuxiliaryText(result);
    const packet = await this.deps.packets.get(topicId, researchVersion);
    const event = packet
      ? await this.deps.gates.event(packet.approvedEventId)
      : undefined;
    let job = await this.deps.jobs.get(topicId, researchVersion);
    const queue = await this.deps.gates.queue(topicId);
    try {
      assertWritingEligibility(packet, event, queue);
    } catch (error) {
      if (job && gateWasCancelled(event, queue))
        await this.update(job, {
          status: "cancelled",
          heartbeatAt: this.now().toISOString(),
        });
      throw error;
    }
    if (
      !job ||
      !["awaiting_manual_writing", "completed"].includes(job.status) ||
      !job.taskHash
    )
      throw new Error("A prepared writing job is required before import");
    job = await this.update(job, {
      status: "importing",
      heartbeatAt: this.now().toISOString(),
    });
    const task = taskInputSchema.parse(
      await this.deps.tasks.readInput(topicId, researchVersion),
    );
    if (
      result.topicId !== topicId ||
      result.researchPacketId !== packet.id ||
      result.researchPacketVersion !== researchVersion ||
      result.articleType !== job.articleType
    )
      throw new Error(
        "Writing output identity does not match the prepared task",
      );
    if (
      task.researchPacketId !== packet.id ||
      task.researchContentHashes.join() !== packet.contentHashes.join() ||
      job.researchContentHashes.join() !== packet.contentHashes.join()
    )
      throw new Error("Research provenance changed after task preparation");
    if (result.mdx.length > this.deps.config.maxMdxCharacters)
      throw new Error("MDX exceeds configured maximum size");
    if (!this.deps.config.allowedCategories.includes(result.metadata.category))
      throw new Error(
        "Category is not in the configured controlled vocabulary",
      );
    if (result.metadata.tags.length > this.deps.config.maximumTags)
      throw new Error("Too many tags");
    if (
      new Set(result.metadata.tags.map((x) => x.toLocaleLowerCase())).size !==
      result.metadata.tags.length
    )
      throw new Error("Duplicate tags are not allowed");
    assertSafeSlug(result.metadata.slug, this.deps.config.slugMaxLength);
    if (task.requestedSlug && result.metadata.slug !== task.requestedSlug)
      throw new Error("Imported slug does not match the operator override");
    const overlap = await detectOverlap(
      this.deps.history,
      packet,
      result.metadata.title,
      result.metadata.slug,
    );
    if (overlap.slugCollision)
      throw new Error(
        "Draft slug collides with another topic in article history",
      );
    const version = await this.deps.drafts.nextVersion(topicId);
    const draftId = `draft_${sha256(topicId).slice(0, 24)}`;
    const now = this.now().toISOString();
    const references = result.claimReferences.map((x) =>
      draftClaimReferenceSchema.parse({ ...x, draftId }),
    );
    job = await this.update(job, { status: "validating", heartbeatAt: now });
    const quality = evaluateDraft(
      result,
      packet,
      references,
      this.deps.config,
      draftId,
      version,
      now,
    );
    if (quality.status === "blocked") {
      await this.update(job, {
        status: "blocked",
        heartbeatAt: now,
        failedAt: now,
        failureCode: "QUALITY_BLOCKED",
        failureMessage: quality.blockingIssues.join("; "),
      });
      throw new Error(
        `Draft import blocked: ${quality.blockingIssues.join("; ")}`,
      );
    }
    const inspection = inspectMdx(
      result.mdx,
      new Set(packet.sourceIndex.map((x) => x.id)),
    );
    const wordCount = quality.wordCount;
    const sourceUrls = [
      ...new Set(
        result.sourceIdsUsed
          .map(
            (id) => packet.sourceIndex.find((x) => x.id === id)?.canonicalUrl,
          )
          .filter((x): x is string => Boolean(x))
          .map(safePublicUrl),
      ),
    ];
    const frontmatter = frontmatterSchema.parse({
      title: result.metadata.title,
      slug: result.metadata.slug,
      description: result.metadata.description,
      publishedAt: null,
      updatedAt: now,
      status: "draft",
      category: result.metadata.category,
      tags: result.metadata.tags,
      author: "Deep",
      heroImage: null,
      heroAlt: result.metadata.heroAlt,
      canonicalUrl: null,
      sources: sourceUrls,
      draft: true,
      articleType: result.articleType,
      readingTime: quality.readingTime,
      researchPacketId: packet.id,
      researchPacketVersion: packet.version,
      sourceDisclosure:
        "Prepared only from the cited research packet; no independent hands-on testing is claimed.",
      reviewDisclosure: "Not editorially reviewed or approved",
    });
    const article = `${renderFrontmatter(frontmatter)}\n${result.mdx.trim()}\n`;
    const draft = articleDraftSchema.parse({
      id: draftId,
      topicId,
      candidateId: packet.candidateId,
      researchPacketId: packet.id,
      researchPacketVersion: packet.version,
      approvedEventId: packet.approvedEventId,
      version,
      status: "validated",
      articleType: result.articleType,
      title: result.metadata.title,
      slug: result.metadata.slug,
      description: result.metadata.description,
      category: result.metadata.category,
      tags: result.metadata.tags,
      author: "Deep",
      heroImage: null,
      heroAlt: result.metadata.heroAlt,
      canonicalUrl: null,
      publishedAt: null,
      updatedAt: now,
      draft: true,
      mdx: result.mdx.trim(),
      plainText: toPlainText(result.mdx),
      wordCount,
      readingTimeMinutes: quality.readingTime,
      headingOutline: inspection.headings.filter((x) => x.level <= 4),
      sourceIds: [...new Set(result.sourceIdsUsed)],
      claimReferences: references,
      researchContentHashes: packet.contentHashes,
      writingMode: "manual_claude_code",
      createdAt: now,
      ...(version > 1 ? { supersedesVersion: version - 1 } : {}),
      provenance: {
        taskHash: job.taskHash,
        importHash,
        importedAt: now,
        importedBy: "manual",
        schemaVersion: "1.0",
      },
      warnings: [...quality.warnings, ...overlap.warnings],
    });
    const latestJob = await this.deps.jobs.get(topicId, researchVersion);
    const finalPacket = await this.deps.packets.get(topicId, researchVersion);
    const finalEvent = await this.deps.gates.event(packet.approvedEventId);
    const finalQueue = await this.deps.gates.queue(topicId);
    try {
      assertWritingEligibility(finalPacket, finalEvent, finalQueue);
    } catch (error) {
      if (latestJob && gateWasCancelled(finalEvent, finalQueue))
        await this.update(latestJob, {
          status: "cancelled",
          heartbeatAt: now,
        });
      throw error;
    }
    if (!latestJob || latestJob.status === "cancelled")
      throw new Error("Writing job was cancelled before persistence");
    await this.deps.drafts.saveBundle(
      draft,
      article,
      draft.plainText,
      quality,
      {
        importedAt: now,
        importedBy: "manual",
        inputPath: resultPath,
        importHash,
        taskHash: job.taskHash,
        researchPacketId: packet.id,
        researchPacketVersion: packet.version,
        researchContentHashes: packet.contentHashes,
      },
    );
    await this.deps.history.add(
      articleHistoryEntrySchema.parse({
        id: `${draft.id}_v${version}`,
        title: draft.title,
        slug: draft.slug,
        entities: [],
        productIdentifiers: packet.productSpecifications.map((x) => x.name),
        keywords: result.suggestedSeoMetadata.keywords,
        articleType: draft.articleType,
        summary: result.plainTextSummary,
        date: now,
        topicId,
        researchContentHashes: packet.contentHashes,
        status: "draft",
      }),
    );
    await this.update(job, {
      status: "completed",
      heartbeatAt: now,
      completedAt: now,
      draftId,
    });
    return { draft, quality, reused: false };
  }

  status(topicId: string, version?: number) {
    return this.deps.jobs.get(topicId, version);
  }
  task(topicId: string, version: number) {
    return this.deps.tasks.readInput(topicId, version);
  }
  draft(topicId: string, version?: number) {
    return this.deps.drafts.get(topicId, version);
  }
  quality(topicId: string, version?: number) {
    return this.deps.quality.get(topicId, version);
  }
  async cancel(topicId: string, version: number) {
    const job = await this.deps.jobs.get(topicId, version);
    if (!job) throw new Error("Writing job not found");
    if (job.status === "completed")
      throw new Error("Completed writing jobs cannot be cancelled");
    return this.update(job, {
      status: "cancelled",
      heartbeatAt: this.now().toISOString(),
    });
  }
  async retry(topicId: string, version: number) {
    const job = await this.deps.jobs.get(topicId, version);
    if (!job || !["blocked", "failed", "cancelled"].includes(job.status))
      throw new Error("Only blocked, failed, or cancelled jobs can be retried");
    await this.deps.jobs.save(
      writingJobSchema.parse({
        ...job,
        status: "failed",
        heartbeatAt: this.now().toISOString(),
        version: job.version + 1,
      }),
    );
    return this.prepare(topicId, version, job.articleType);
  }
  private async update(job: WritingJob, change: Partial<WritingJob>) {
    const updated = writingJobSchema.parse({
      ...job,
      ...change,
      version: job.version + 1,
    });
    await this.deps.jobs.save(updated);
    return updated;
  }
}
function safePublicUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
      url.hostname,
    )
  )
    throw new Error("Source URL is not safe for public draft frontmatter");
  for (const key of [...url.searchParams.keys()]) {
    if (/(?:token|key|secret|password|signature)/i.test(key))
      throw new Error("Source URL contains a sensitive query parameter");
    if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}
function assertNoExecutableAuxiliaryText(
  result: z.infer<typeof articleWritingResultSchema>,
) {
  const auxiliary = [...result.writerNotes, ...result.unresolvedQuestions];
  if (
    auxiliary.some((value) =>
      /(?:^|\s)(?:sudo|bash|sh|zsh|rm|curl|wget|npm|npx|node|python)\s+|(?:^|\s)(?:\.\.?\/|\/[A-Za-z0-9_.-]+\/)/i.test(
        value,
      ),
    )
  )
    throw new Error(
      "Writer notes and unresolved questions must not contain commands or file paths",
    );
}
function gateWasCancelled(
  event: { status: string } | undefined,
  queue:
    | {
        approvalStatus: string;
        researchReadiness: string;
        triggerState: string;
      }
    | undefined,
) {
  return (
    !event ||
    event.status !== "ready" ||
    !queue ||
    queue.approvalStatus !== "approved" ||
    queue.researchReadiness !== "ready_for_research" ||
    queue.triggerState !== "topic_approved_event_created"
  );
}
