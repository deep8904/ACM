import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ResearchPacketRepository } from "../research/interfaces";
import type { WritingConfig } from "../writing/config";
import type {
  ArticleDraftRepository,
  ArticleHistoryRepository,
  DraftQualityRepository,
} from "../writing/interfaces";
import { inspectMdx, renderFrontmatter, toPlainText } from "../writing/mdx";
import {
  articleDraftSchema,
  articleHistoryEntrySchema,
  articleWritingResultSchema,
  draftClaimReferenceSchema,
  frontmatterSchema,
  type ArticleDraft,
} from "../writing/models";
import { evaluateDraft } from "../writing/quality";
import { assertSafeSlug } from "../writing/slug";
import { sha256 } from "../writing/task";
import type {
  EditorialReviewRepository,
  FinalApprovedEventRepository,
  FinalApprovalRepository,
  DraftPreviewRepository,
  ReviewGateRepository,
  RevisionTaskRepository,
} from "./interfaces";
import {
  revisionRequestSchema,
  revisionResultSchema,
  type EditorialIssue,
  type RevisionRequest,
  type RevisionScope,
} from "./models";
import { createRevisionTask } from "./task";

const revisionTaskInputSchema = z
  .object({
    topicId: z.string(),
    sourceDraftId: z.string(),
    sourceDraftVersion: z.number().int(),
    articleHash: z.string(),
    researchPacketId: z.string(),
    researchPacketVersion: z.number().int(),
    researchContentHashes: z.array(z.string()),
    request: revisionRequestSchema,
  })
  .passthrough();
export interface RevisionServiceDependencies {
  drafts: ArticleDraftRepository;
  quality: DraftQualityRepository;
  history: ArticleHistoryRepository;
  packets: ResearchPacketRepository;
  reviews: EditorialReviewRepository;
  tasks: RevisionTaskRepository;
  approvals: FinalApprovalRepository;
  events: FinalApprovedEventRepository;
  previews: DraftPreviewRepository;
  gates: ReviewGateRepository;
  writingConfig: WritingConfig;
  clock?: () => Date;
}
export class RevisionService {
  constructor(private deps: RevisionServiceDependencies) {}
  private now() {
    return (this.deps.clock ?? (() => new Date()))();
  }
  async prepare(
    topicId: string,
    draftVersion: number,
    issueIds: string[],
    options: {
      scope?: RevisionScope;
      requestedChange?: string;
      origin?: RevisionRequest["origin"];
    } = {},
  ) {
    const draft = await this.deps.drafts.get(topicId, draftVersion);
    const review = await this.deps.reviews.get(topicId, draftVersion);
    if (!draft || !review)
      throw new Error("Draft and editorial review are required");
    const unique = [...new Set(issueIds)];
    const issues = review.issues.filter(
      (x) => unique.includes(x.id) && x.status === "open",
    );
    const telegramFreeform =
      options.origin === "telegram" && Boolean(options.requestedChange?.trim());
    if (
      (!unique.length && !telegramFreeform) ||
      issues.length !== unique.length
    )
      throw new Error(
        "Every requested issue ID must be open and belong to the selected review",
      );
    const packet = await this.deps.packets.get(
      topicId,
      draft.researchPacketVersion,
    );
    if (!packet) throw new Error("Research packet is missing");
    if (!(await this.deps.gates.topicActive(topicId, draft.approvedEventId)))
      throw new Error("Topic approval is no longer active");
    const scope =
      options.scope ??
      (telegramFreeform ? "full_revision" : inferScope(issues));
    const now = this.now().toISOString();
    const affectedReferences = new Set(
      issues.flatMap((x) => x.claimReferenceIds),
    );
    const protectedResearchClaimIds = [
      ...new Set(
        draft.claimReferences
          .filter((x) => !affectedReferences.has(x.id))
          .flatMap((x) => x.researchClaimIds),
      ),
    ];
    const request = revisionRequestSchema.parse({
      id: `revision_${sha256(`${draft.id}:${draftVersion}:${unique.sort().join(",")}:${scope}`).slice(0, 24)}`,
      topicId,
      draftId: draft.id,
      draftVersion,
      issueIds: unique,
      requestedChange:
        options.requestedChange ??
        issues.map((x) => x.suggestedCorrection || x.description).join("\n"),
      sectionsAffected: [
        ...new Set(issues.flatMap((x) => (x.section ? [x.section] : []))),
      ],
      claimReferenceIds: [...affectedReferences],
      sourceIdsThatMustRemain: [
        ...new Set(
          issues.length ? issues.flatMap((x) => x.sourceIds) : draft.sourceIds,
        ),
      ],
      protectedResearchClaimIds,
      allowTitleChange: ["title_only", "full_revision"].includes(scope),
      allowDescriptionChange: ["description_only", "full_revision"].includes(
        scope,
      ),
      allowStructureChange: ["structure_adjustment", "full_revision"].includes(
        scope,
      ),
      allowBodyChange: !["title_only", "description_only"].includes(scope),
      scope,
      origin: options.origin ?? "editorial_review",
      createdAt: now,
      status: "task_ready",
      version: 1,
    });
    const bundle = createRevisionTask(draft, review, request, packet, now);
    await this.deps.tasks.saveRequest(request);
    const taskDirectory = await this.deps.tasks.write(
      topicId,
      draftVersion,
      bundle.files,
    );
    return { request, taskHash: bundle.taskHash, taskDirectory };
  }
  async import(topicId: string, draftVersion: number, path: string) {
    const raw = await readFile(path, "utf8");
    const importHash = sha256(raw);
    const reused = await this.deps.drafts.findByImportHash(importHash);
    if (reused)
      return {
        draft: reused,
        quality: await this.deps.quality.get(topicId, reused.version),
        reused: true,
      };
    const result = revisionResultSchema.parse(JSON.parse(raw));
    const source = await this.deps.drafts.get(topicId, draftVersion);
    const request = await this.deps.tasks.getRequest(topicId, draftVersion);
    if (!source || !request)
      throw new Error(
        "Prepared revision request and source draft are required",
      );
    const packet = await this.deps.packets.get(
      topicId,
      source.researchPacketVersion,
    );
    if (!packet) throw new Error("Research packet is missing");
    const task = revisionTaskInputSchema.parse(
      await this.deps.tasks.readInput(topicId, draftVersion),
    );
    const taskHash = sha256(`${JSON.stringify(task, null, 2)}\n`);
    const provenanceMismatches = [
      result.topicId !== topicId && "topicId",
      result.sourceDraftId !== source.id && "sourceDraftId",
      result.sourceDraftVersion !== draftVersion && "sourceDraftVersion",
      result.revisionScope !== request.scope && "revisionScope",
      result.provenance.taskHash !== taskHash && "taskHash",
      task.articleHash !== sha256(JSON.stringify(source)) && "articleHash",
      task.researchContentHashes.join() !== packet.contentHashes.join() &&
        "researchContentHashes",
    ].filter((value): value is string => Boolean(value));
    if (provenanceMismatches.length)
      throw new Error(
        `Revision immutable provenance mismatch: ${provenanceMismatches.join(", ")}`,
      );
    if (
      !request.issueIds.every((id) => result.addressedIssueIds.includes(id)) ||
      result.unresolvedIssues.some((id) => request.issueIds.includes(id))
    )
      throw new Error("Revision did not address every required issue");
    enforcePermissions(source, result, request);
    validateProtectedClaims(source, result.claimReferences, request);
    if (
      !request.sourceIdsThatMustRemain.every((id) =>
        result.sourceIdsUsed.includes(id),
      )
    )
      throw new Error("Revision removed a required source");
    const knownSources = new Set(packet.sourceIndex.map((x) => x.id));
    const knownClaims = new Set(
      [
        ...packet.facts,
        ...packet.interpretations,
        ...packet.predictions,
        ...packet.communityObservations,
      ].map((x) => x.id),
    );
    for (const reference of result.claimReferences)
      if (
        reference.sourceIds.some((id) => !knownSources.has(id)) ||
        reference.researchClaimIds.some((id) => !knownClaims.has(id))
      )
        throw new Error(
          "Revision contains unknown source or research claim IDs",
        );
    assertSafeSlug(result.slug, this.deps.writingConfig.slugMaxLength);
    const version = await this.deps.drafts.nextVersion(topicId);
    const now = this.now().toISOString();
    const references = result.claimReferences.map((x) =>
      draftClaimReferenceSchema.parse({ ...x, draftId: source.id }),
    );
    const inspection = inspectMdx(result.mdx, knownSources);
    const plain = toPlainText(result.mdx);
    const synthetic = articleWritingResultSchema.parse({
      schemaVersion: "1.0",
      topicId,
      researchPacketId: packet.id,
      researchPacketVersion: packet.version,
      articleType: source.articleType,
      metadata: {
        title: result.title,
        alternateTitles: result.alternateTitles,
        seoTitle: result.title.slice(0, 70),
        socialHeadline: result.title.slice(0, 100),
        slug: result.slug,
        description: result.description,
        excerpt: result.description.slice(0, 300),
        category: source.category,
        tags: source.tags,
        author: "Deep",
        heroImage: null,
        heroAlt: source.heroAlt,
        canonicalUrl: null,
        publishedAt: null,
        status: "draft",
        draft: true,
      },
      mdx: result.mdx,
      plainTextSummary: summary(plain),
      headingOutline: inspection.headings.filter((x) => x.level <= 4),
      claimReferences: result.claimReferences,
      sourceIdsUsed: result.sourceIdsUsed,
      declaredAnalysisSections: [],
      declaredOpinionSections: [],
      limitations: packet.unknowns.length
        ? packet.unknowns
        : ["No additional limitations were supplied by the revision."],
      heroImageBrief: {
        editorialPurpose: "Preserve the existing textual visual brief",
        subject: source.heroAlt,
        composition: "Unchanged from the reviewed draft",
        mood: "Editorial",
        background: "Neutral",
        aspectRatio: "16:9",
        recommendation: "no_image",
        mustNotDepict: ["Unsupported product behavior"],
        altTextDraft: source.heroAlt,
        misinformationRisk: "No image is generated in this milestone.",
      },
      suggestedSeoMetadata: {
        keywords: source.tags,
        searchIntent: "Informational",
      },
      writerNotes: result.writerNotes,
      unresolvedQuestions: result.unresolvedIssues,
    });
    const quality = evaluateDraft(
      synthetic,
      packet,
      references,
      this.deps.writingConfig,
      source.id,
      version,
      now,
    );
    if (quality.status === "blocked")
      throw new Error(
        `Revision quality blocked: ${quality.blockingIssues.join("; ")}`,
      );
    const sources = result.sourceIdsUsed
      .map((id) => packet.sourceIndex.find((x) => x.id === id)?.canonicalUrl)
      .filter((x): x is string => Boolean(x));
    const frontmatter = frontmatterSchema.parse({
      title: result.title,
      slug: result.slug,
      description: result.description,
      publishedAt: null,
      updatedAt: now,
      status: "draft",
      category: source.category,
      tags: source.tags,
      author: "Deep",
      heroImage: null,
      heroAlt: source.heroAlt,
      canonicalUrl: null,
      sources: [...new Set(sources)],
      draft: true,
      articleType: source.articleType,
      readingTime: quality.readingTime,
      researchPacketId: packet.id,
      researchPacketVersion: packet.version,
      sourceDisclosure:
        "Prepared only from the cited research packet; no independent hands-on testing is claimed.",
      reviewDisclosure: "Not editorially reviewed or approved",
    });
    const article = `${renderFrontmatter(frontmatter)}\n${result.mdx.trim()}\n`;
    const draft = articleDraftSchema.parse({
      ...source,
      version,
      status: "validated",
      title: result.title,
      slug: result.slug,
      description: result.description,
      mdx: result.mdx.trim(),
      plainText: plain,
      wordCount: quality.wordCount,
      readingTimeMinutes: quality.readingTime,
      headingOutline: inspection.headings.filter((x) => x.level <= 4),
      sourceIds: [...new Set(result.sourceIdsUsed)],
      claimReferences: references,
      updatedAt: now,
      createdAt: now,
      supersedesVersion: source.version,
      provenance: {
        taskHash,
        importHash,
        importedAt: now,
        importedBy: "manual",
        schemaVersion: "1.0",
      },
      warnings: quality.warnings,
    });
    if (!(await this.deps.gates.topicActive(topicId, source.approvedEventId)))
      throw new Error("Topic was cancelled before revised draft persistence");
    await this.deps.drafts.saveBundle(draft, article, plain, quality, {
      inputPath: path,
      importHash,
      taskHash,
      sourceDraftVersion: source.version,
      revisionRequestId: request.id,
      importedAt: now,
    });
    await this.deps.tasks.saveResolution(
      topicId,
      draftVersion,
      request.issueIds,
      version,
      now,
    );
    await this.deps.reviews.resolveIssues(
      topicId,
      draftVersion,
      request.issueIds,
      version,
      now,
    );
    await this.deps.tasks.saveRequest(
      revisionRequestSchema.parse({
        ...request,
        status: "completed",
        version: request.version + 1,
      }),
    );
    await this.invalidateApproval(topicId, draftVersion, now);
    await this.deps.previews.supersede(topicId, draftVersion, now);
    await this.deps.history.add(
      articleHistoryEntrySchema.parse({
        id: `${draft.id}_v${version}`,
        title: draft.title,
        slug: draft.slug,
        entities: [],
        productIdentifiers: packet.productSpecifications.map((x) => x.name),
        keywords: source.tags,
        articleType: draft.articleType,
        summary: summary(plain),
        date: now,
        topicId,
        researchContentHashes: packet.contentHashes,
        status: "draft",
      }),
    );
    return { draft, quality, reused: false };
  }
  private async invalidateApproval(
    topicId: string,
    oldVersion: number,
    now: string,
  ) {
    const approval = await this.deps.approvals.get(topicId);
    if (
      approval &&
      approval.draftVersion === oldVersion &&
      ["pending", "approved", "scheduled"].includes(approval.status)
    )
      await this.deps.approvals.save({
        ...approval,
        status: "superseded",
        updatedAt: now,
        version: approval.version + 1,
      });
    const event = await this.deps.events.get(topicId);
    if (
      event &&
      event.draftVersion === oldVersion &&
      !["consumed", "cancelled", "superseded"].includes(event.status)
    )
      await this.deps.events.update(
        { ...event, status: "superseded", version: event.version + 1 },
        event.version,
      );
  }
}
function inferScope(issues: EditorialIssue[]): RevisionScope {
  if (issues.every((x) => x.category === "headline_accuracy"))
    return "title_only";
  if (issues.every((x) => x.category === "citation")) return "citation_fix";
  if (issues.every((x) => x.category === "product_disclosure"))
    return "disclosure_fix";
  if (
    issues.every((x) =>
      ["brand_voice", "ai_style", "clarity"].includes(x.category),
    )
  )
    return "tone_adjustment";
  if (issues.every((x) => x.category === "structure"))
    return "structure_adjustment";
  return "full_revision";
}
function enforcePermissions(
  source: ArticleDraft,
  result: z.infer<typeof revisionResultSchema>,
  request: RevisionRequest,
) {
  if (!request.allowTitleChange && result.title !== source.title)
    throw new Error("Revision changed protected title");
  if (
    !request.allowDescriptionChange &&
    result.description !== source.description
  )
    throw new Error("Revision changed protected description");
  if (!request.allowBodyChange && result.mdx.trim() !== source.mdx.trim())
    throw new Error("Revision changed protected body");
  if (!request.allowStructureChange && request.scope === "introduction_only") {
    const a = source.mdx.search(/^##\s/m);
    const b = result.mdx.search(/^##\s/m);
    if (a < 0 || b < 0 || source.mdx.slice(a) !== result.mdx.slice(b))
      throw new Error("Introduction-only revision changed article sections");
  }
  if (result.slug !== source.slug)
    throw new Error("Revision cannot silently change the existing slug");
}
function validateProtectedClaims(
  source: ArticleDraft,
  revised: z.infer<typeof revisionResultSchema>["claimReferences"],
  request: RevisionRequest,
) {
  for (const id of request.protectedResearchClaimIds) {
    const before = source.claimReferences.find((x) =>
      x.researchClaimIds.includes(id),
    );
    const after = revised.find((x) => x.researchClaimIds.includes(id));
    if (
      !before ||
      !after ||
      before.statement !== after.statement ||
      before.sourceIds.join() !== after.sourceIds.join() ||
      before.claimType !== after.claimType
    )
      throw new Error(
        `Protected research claim changed without support: ${id}`,
      );
  }
}
function summary(value: string) {
  const text = value.replace(/\s+/g, " ").trim().slice(0, 1000);
  return text.length >= 40
    ? text
    : `${text} This revised draft remains pending a new editorial review.`;
}
