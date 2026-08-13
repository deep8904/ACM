import { createHash } from "node:crypto";
import type { SourceItem } from "../discovery/models/source-item";
import { normalizeUrl } from "../discovery/normalize-url";
import type { TopicCatalog } from "../telegram/interfaces";
import type { TopicApprovedEvent, TopicQueueItem } from "../telegram/models";
import { analyze, publisherOwnershipGroup } from "./analyze";
import type { ResearchConfig } from "./config";
import { contentHash, extractDocument } from "./extract";
import { GitHubJsonContentExtractor } from "./github-adapter";
import type {
  ApprovedEventRepository,
  HumanAssistedEvidenceRepository,
  ResearchJobRepository,
  ResearchPacketRepository,
  ResearchCacheRepository,
  ResearchSourceRepository,
  ResearchSourceExtensionRepository,
} from "./interfaces";
import {
  researchPacketSchema,
  researchSourceSchema,
  type ResearchJob,
  type ResearchPacket,
  type ResearchSource,
} from "./models";
import { isMissingPrimaryReason } from "./primary-evidence";
import { z } from "zod";
import {
  ResearchRetrievalError,
  retrieveSafely,
  robotsAllows,
  type ResearchFetch,
  type RetrievalPolicyHooks,
} from "./retrieve";
import { stable } from "./storage";
import type { DnsLookup } from "../telegram/interfaces";
import { validateManualUrl } from "../telegram/safe-url";
import { extractOfficialAlternateUrls } from "./alternates";

export class ResearchService {
  constructor(
    private deps: {
      events: ApprovedEventRepository;
      jobs: ResearchJobRepository;
      sources: ResearchSourceRepository;
      packets: ResearchPacketRepository;
      cache?: ResearchCacheRepository;
      extensions?: ResearchSourceExtensionRepository;
      humanEvidence?: HumanAssistedEvidenceRepository;
      catalog: TopicCatalog;
      config: ResearchConfig;
      fetch?: ResearchFetch;
      lookup?: DnsLookup;
      now?: () => Date;
      workerId?: string;
    },
  ) {}
  async next() {
    const event = await this.deps.events.next();
    return event ? this.process(event.id) : undefined;
  }
  async process(eventId: string): Promise<ResearchPacket | undefined> {
    return this.run(eventId);
  }
  async retry(eventId: string): Promise<ResearchPacket | undefined> {
    const job = await this.deps.jobs.getByEvent(eventId);
    if (!job) throw new Error("Research job not found");
    if (job.status === "failed") return this.run(eventId, ["failed"]);
    if (job.status !== "awaiting_assistance")
      throw new Error("Only failed or retrieval-blocked jobs can be retried");
    const packet = await this.deps.packets.get(job.topicId, job.packetVersion);
    if (
      !packet?.sourceIndex.some(({ extractionStatus }) =>
        ["blocked", "failed", "unsupported"].includes(extractionStatus),
      )
    )
      throw new Error("Only failed or retrieval-blocked jobs can be retried");
    return this.run(eventId, ["awaiting_assistance"]);
  }
  async inspectSource(input: { topicId: string; url: string }) {
    const request = z
      .object({ topicId: z.string().min(1), url: z.string().min(1).max(2048) })
      .strict()
      .parse(input);
    const canonicalUrl = await validateManualUrl(request.url, this.deps.lookup);
    const base = await this.deps.packets.get(request.topicId);
    if (!base) throw new Error("Research packet not found");
    const event = await this.deps.events.get(base.approvedEventId);
    const queue = await this.deps.events.queue(request.topicId);
    if (
      !event ||
      event.status !== "ready" ||
      !queue ||
      queue.approvalStatus !== "approved" ||
      !["ready_for_research", "awaiting_source"].includes(
        queue.researchReadiness,
      ) ||
      (await this.deps.events.isCancelled(event)) ||
      !(await this.deps.events.isConsumed(event.id))
    )
      throw new Error("Topic approval gate is not active");
    const duplicate = base.sourceIndex.find((source) =>
      [source.originalUrl, source.canonicalUrl, source.finalUrl].some(
        (url) => normalizeUrl(url) === canonicalUrl,
      ),
    );
    if (duplicate)
      throw new ResearchSourceInspectionError(
        "duplicate",
        "That source URL is already in the latest research packet",
      );
    const owner = ownerForHost(new URL(canonicalUrl).hostname);
    const sourceType = inferExtensionType(canonicalUrl);
    const publisher = publisherForOwner(owner);
    const proposedAuthority = ownershipMatchesTopic(base, owner)
      ? ("primary" as const)
      : ("independent" as const);
    const metadata: ResearchSourceExtensionInput = {
      topicId: request.topicId,
      url: canonicalUrl,
      authority: proposedAuthority,
      sourceType:
        proposedAuthority === "primary" ? sourceType : "technical_reporting",
      publisher,
      publisherOwner: owner,
    };
    const artifact = await this.collect(
      event,
      extensionItem(canonicalUrl, metadata, new Date().toISOString()),
      metadata,
      false,
    );
    if (artifact.source.extractionStatus !== "extracted") {
      const warning = artifact.source.warnings.join("; ");
      const kind = /robots_denied|robots/i.test(warning)
        ? "robots_denied"
        : /429_retry_after/i.test(warning)
          ? "429_retry_after"
          : /429_cooldown|HTTP 429/i.test(warning)
            ? "429_cooldown"
            : /403_forbidden|HTTP 403/i.test(warning)
              ? "403_forbidden"
              : "retrieval";
      const retryAt = /(?:retry at|until) ([^;\s]+)/i.exec(warning)?.[1];
      throw new ResearchSourceInspectionError(
        kind,
        kind === "robots_denied"
          ? "That page blocks automated retrieval through robots.txt"
          : kind === "429_retry_after" || kind === "429_cooldown"
            ? "That page is rate-limiting retrieval (HTTP 429)"
            : kind === "403_forbidden"
              ? "That page refused retrieval (HTTP 403)"
              : "That page could not be retrieved as usable evidence",
        retryAt,
      );
    }
    return {
      canonicalUrl,
      title: artifact.source.title,
      publisher,
      publisherOwner: owner,
      sourceType,
      proposedAuthority,
      reason:
        proposedAuthority === "primary"
          ? `The publisher domain matches the approved topic identity; operator confirmation is still required.`
          : "Publisher ownership could not be tied deterministically to the topic, so independent is the safe default.",
      contentHash: artifact.source.contentHash,
    };
  }
  async extendSource(input: ResearchSourceExtensionInput) {
    const request = researchSourceExtensionInputSchema.parse(input);
    const canonicalUrl = normalizeUrl(request.url);
    const base = await this.deps.packets.get(request.topicId);
    if (!base) throw new Error("Research packet not found");
    const event = await this.deps.events.get(base.approvedEventId);
    const queue = await this.deps.events.queue(request.topicId);
    if (
      !event ||
      event.status !== "ready" ||
      event.topicId !== request.topicId ||
      !queue ||
      queue.approvalStatus !== "approved" ||
      !["ready_for_research", "awaiting_source"].includes(
        queue.researchReadiness,
      ) ||
      queue.candidateId !== base.candidateId ||
      (await this.deps.events.isCancelled(event))
    )
      throw new Error("Topic approval gate is not active");
    if (!(await this.deps.events.isConsumed(event.id)))
      throw new Error("Source extension is only supported for consumed topics");
    validateExtensionClassification(base, canonicalUrl, request);
    const duplicate = base.sourceIndex.find((source) =>
      [source.originalUrl, source.canonicalUrl, source.finalUrl].some(
        (url) => normalizeUrl(url) === canonicalUrl,
      ),
    );
    if (duplicate) {
      if (sameExtensionClassification(duplicate, request)) return base;
      throw new Error(
        "Source URL already exists with different classification metadata",
      );
    }
    if (base.sourceIndex.length >= this.deps.config.maxSources)
      throw new Error("Research packet has reached the configured source cap");
    if (!this.deps.extensions)
      throw new Error("Source extension repository is not configured");

    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const item = extensionItem(canonicalUrl, request, now);
    const artifact = await this.collect(event, item, request, false);
    const sources = limitExcerpts(
      [...base.sourceIndex, artifact.source],
      this.deps.config.totalExcerptChars,
    );
    const deterministic = analyze(request.topicId, sources, now, {
      ...this.deps.config,
      mode: "deterministic",
    });
    const inheritedClaimCount = [
      ...base.facts,
      ...base.interpretations,
      ...base.predictions,
      ...base.communityObservations,
    ].filter((claim) =>
      ["supported", "partially_supported"].includes(claim.status),
    ).length;
    const components = {
      ...deterministic.sufficiency.components,
      claimCoverage: Math.max(
        base.researchSufficiency.components.claimCoverage,
        Math.min(20, inheritedClaimCount * 4),
      ),
    };
    const penalties = {
      conflicts: Math.max(
        base.researchSufficiency.penalties.conflicts,
        deterministic.sufficiency.penalties.conflicts,
      ),
      // Evidence extension never removes an unknowns penalty. A later assisted
      // import may resolve unknowns only by citing excerpts from this packet.
      unknowns: base.researchSufficiency.penalties.unknowns,
      weakSources: deterministic.sufficiency.penalties.weakSources,
    };
    const score = Math.max(
      0,
      Math.min(
        100,
        Object.values(components).reduce((sum, value) => sum + value, 0) -
          Object.values(penalties).reduce((sum, value) => sum + value, 0),
      ),
    );
    const extensionHash = createHash("sha256")
      .update(
        JSON.stringify({
          topicId: request.topicId,
          canonicalUrl,
          authority: request.authority,
          sourceType: request.sourceType,
          publisher: request.publisher,
          publisherOwner: request.publisherOwner.toLowerCase(),
        }),
      )
      .digest("hex");
    const newClaims = deterministic.claims.filter(
      (claim) =>
        claim.sourceIds.includes(artifact.source.id) &&
        ![
          ...base.facts,
          ...base.interpretations,
          ...base.predictions,
          ...base.communityObservations,
        ].some((existing) => existing.id === claim.id),
    );
    const next = researchPacketSchema.parse({
      ...base,
      version: base.version + 1,
      updatedAt: now,
      status:
        artifact.source.extractionStatus === "extracted"
          ? "awaiting_assisted_synthesis"
          : "insufficient",
      researchMode: "deterministic",
      facts: [...base.facts, ...newClaims],
      timeline: uniqueById([...base.timeline, ...deterministic.timeline]),
      conflicts: uniqueById([...base.conflicts, ...deterministic.conflicts]),
      sourceIndex: sources,
      primarySourceIds: sources
        .filter((source) => source.isPrimary)
        .map((source) => source.id),
      sufficient: false,
      blockingReasons: uniqueStrings([
        ...base.blockingReasons,
        ...deterministic.blockingReasons,
      ]),
      warnings: uniqueStrings([...base.warnings, ...artifact.source.warnings]),
      contentHashes: uniqueStrings(sources.map((source) => source.contentHash)),
      researchConfidence: Math.min(1, score / 100),
      researchSufficiency: {
        score,
        threshold: base.researchSufficiency.threshold,
        components,
        penalties,
        explanation: [
          `${sources.filter((source) => source.isPrimary).length} primary source(s)`,
          `${new Set(sources.map(publisherOwnershipGroup)).size} publisher ownership group(s)`,
          `${inheritedClaimCount + newClaims.length} supported claim(s) available for synthesis`,
          `Extended immutable packet v${base.version} with one validated source`,
        ],
      },
      provenance: {
        deterministic: true,
        promptVersion: base.provenance.promptVersion,
        sourcePacketVersion: base.version,
        extensionHash,
        extension: {
          kind: "source_extension",
          canonicalUrl,
          sourceId: artifact.source.id,
          authority: request.authority,
          sourceType: request.sourceType,
          publisher: request.publisher,
          publisherOwner: request.publisherOwner.toLowerCase(),
        },
      },
    });
    return this.deps.extensions.persist(
      base,
      next,
      artifact.source,
      artifact.text,
    );
  }
  async verifyHumanAssistedPrimarySource(topicId: string, url: string) {
    const canonicalUrl = await validateManualUrl(url, this.deps.lookup);
    const base = await this.deps.packets.get(topicId);
    if (!base) throw new Error("Research packet not found");
    await this.assertActiveExtensionGate(base, topicId);
    const publisherOwner = ownerForHost(new URL(canonicalUrl).hostname);
    if (!ownershipMatchesTopic(base, publisherOwner))
      throw new Error(
        "Human-assisted primary evidence is limited to a verified official publisher URL for this topic",
      );
    const sourceType = inferExtensionType(canonicalUrl);
    if (!primarySourceTypes.has(sourceType))
      throw new Error("This official URL type cannot be classified as primary");
    return {
      canonicalUrl,
      publisherOwner,
      publisher: publisherForOwner(publisherOwner),
      sourceType,
    };
  }

  async acceptHumanAssistedEvidence(input: {
    topicId: string;
    remediationId: string;
    eventId: string;
    jobId: string;
    url: string;
    evidenceText: string;
    operatorActorHash: string;
    provenanceStatement: string;
    originalFailureCode:
      | "429_retry_after"
      | "429_cooldown"
      | "robots_denied"
      | "403_forbidden"
      | "retrieval";
    originalDiagnosticId: string;
  }) {
    const request = z
      .object({
        topicId: z.string().min(1),
        remediationId: z.string().regex(/^remediation_[a-f0-9]{24}$/),
        eventId: z.string().regex(/^event_[a-f0-9]{24}$/),
        jobId: z.string().regex(/^automationjob_[a-f0-9]{24}$/),
        url: z.string().min(1).max(2048),
        evidenceText: z.string().min(1).max(20_000),
        operatorActorHash: z.string().regex(/^[a-f0-9]{64}$/),
        provenanceStatement: z.string().min(1).max(500),
        originalFailureCode: z.enum([
          "429_retry_after",
          "429_cooldown",
          "robots_denied",
          "403_forbidden",
          "retrieval",
        ]),
        originalDiagnosticId: z.string().regex(/^diag_[a-f0-9]{16}$/),
      })
      .strict()
      .parse(input);
    const evidenceText = normalizeHumanEvidence(request.evidenceText);
    if (Buffer.byteLength(evidenceText, "utf8") > 20_000)
      throw new HumanEvidenceValidationError(
        "Evidence is too large. Keep the total under 20,000 bytes.",
      );
    if (evidenceText.length < 120 || evidenceText.split(/\s+/).length < 20)
      throw new HumanEvidenceValidationError(
        "Please provide at least 20 words and 120 characters copied from the official page so claims can be validated.",
      );
    if (!this.deps.humanEvidence)
      throw new Error("Human-assisted evidence repository is not configured");
    const official = await this.verifyHumanAssistedPrimarySource(
      request.topicId,
      request.url,
    );
    const base = await this.deps.packets.get(request.topicId);
    if (!base || base.approvedEventId !== request.eventId)
      throw new Error("Evidence does not match the immutable topic event");
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const evidenceHash = createHash("sha256")
      .update(evidenceText)
      .digest("hex");
    const evidenceRecordId = stable(
      "evidence",
      `${request.remediationId}:${evidenceHash}`,
    );
    const excerpts = humanEvidenceExcerpts(
      request.topicId,
      evidenceRecordId,
      evidenceText,
    );
    const source = researchSourceSchema.parse({
      id: stable(
        "source",
        `${request.topicId}:${official.canonicalUrl}:human:${evidenceHash}`,
      ),
      topicId: request.topicId,
      originalUrl: official.canonicalUrl,
      canonicalUrl: official.canonicalUrl,
      finalUrl: official.canonicalUrl,
      title: `Operator-supplied evidence from ${official.publisher}`,
      publisher: official.publisher,
      publisherGroup: official.publisherOwner,
      publisherOwner: official.publisherOwner,
      sourceType: official.sourceType,
      authority: "primary",
      isPrimary: true,
      retrievedAt: now,
      contentType: "text/plain; acquisition=human-assisted",
      language: "en",
      contentHash: evidenceHash,
      extractionMethod: "human_evidence",
      extractionStatus: "extracted",
      extractionQuality: excerpts.length >= 3 ? "high" : "medium",
      qualityMetrics: {
        wordCount: evidenceText.split(/\s+/).length,
        paragraphCount: excerpts.length,
        headingCount: 0,
        metadataFields: 5,
      },
      wordCount: evidenceText.split(/\s+/).length,
      summary: evidenceText.slice(0, 500),
      selectedExcerpts: excerpts,
      licenseNotes:
        "Operator attested that this evidence was copied from the canonical official page; stored for research provenance only.",
      warnings: [
        "Human-assisted primary evidence; not automatically retrieved",
        `Original retrieval failure: ${request.originalFailureCode} (${request.originalDiagnosticId})`,
      ],
      rawMetadata: {
        acquisitionMode: "human_assisted_primary_evidence",
        evidenceRecordId,
      },
      acquisitionMode: "human_assisted_primary_evidence",
      evidenceRecordId,
      operatorActorHash: request.operatorActorHash,
      originalRetrievalFailure: {
        code: request.originalFailureCode,
        diagnosticId: request.originalDiagnosticId,
      },
    });
    const withoutFailedCanonical = base.sourceIndex.filter(
      (candidate) =>
        normalizeUrl(candidate.canonicalUrl) !== official.canonicalUrl ||
        candidate.extractionStatus === "extracted",
    );
    if (withoutFailedCanonical.length >= this.deps.config.maxSources)
      throw new HumanEvidenceValidationError(
        "The research packet has reached its source cap. Remove no history; provide another official source only after a new remediation packet is created.",
      );
    const sources = limitExcerpts(
      [...withoutFailedCanonical, source],
      this.deps.config.totalExcerptChars,
    );
    const deterministic = analyze(request.topicId, sources, now, {
      ...this.deps.config,
      mode: "deterministic",
    });
    const priorBlocking = base.blockingReasons.filter(
      (reason) =>
        !isMissingPrimaryReason(reason) &&
        !/^No supported factual claims were extracted$/i.test(reason),
    );
    const blockingReasons = uniqueStrings([
      ...priorBlocking,
      ...deterministic.blockingReasons,
    ]);
    const next = researchPacketSchema.parse({
      ...base,
      version: base.version + 1,
      updatedAt: now,
      status: "awaiting_assisted_synthesis",
      researchMode: "deterministic",
      facts: uniqueById([...base.facts, ...deterministic.claims]),
      timeline: uniqueById([...base.timeline, ...deterministic.timeline]),
      conflicts: uniqueById([...base.conflicts, ...deterministic.conflicts]),
      sourceIndex: sources,
      primarySourceIds: sources
        .filter((candidate) => candidate.isPrimary)
        .map((candidate) => candidate.id),
      sufficient: false,
      blockingReasons,
      warnings: uniqueStrings([...base.warnings, ...source.warnings]),
      contentHashes: uniqueStrings(
        sources.map((candidate) => candidate.contentHash),
      ),
      researchConfidence: Math.min(1, deterministic.sufficiency.score / 100),
      researchSufficiency: deterministic.sufficiency,
      provenance: {
        deterministic: true,
        promptVersion: base.provenance.promptVersion,
        sourcePacketVersion: base.version,
        humanAssistedEvidence: {
          evidenceRecordId,
          acquisitionMode: "human_assisted_primary_evidence",
          canonicalUrl: official.canonicalUrl,
          publisherOwner: official.publisherOwner,
          operatorActorHash: request.operatorActorHash,
          evidenceHash,
          confirmedAt: now,
          originalRetrievalFailure: {
            code: request.originalFailureCode,
            diagnosticId: request.originalDiagnosticId,
          },
        },
      },
    });
    return this.deps.humanEvidence.persist(base, next, source, {
      id: evidenceRecordId,
      remediationId: request.remediationId,
      topicId: request.topicId,
      eventId: request.eventId,
      jobId: request.jobId,
      basePacketVersion: base.version,
      packetVersion: base.version + 1,
      sourceId: source.id,
      sourceContentHash: source.contentHash,
      canonicalUrl: official.canonicalUrl,
      publisherOwner: official.publisherOwner,
      acquisitionMode: "human_assisted_primary_evidence",
      operatorActorHash: request.operatorActorHash,
      evidenceHash,
      evidenceText,
      provenanceStatement: request.provenanceStatement,
      originalDiagnosticId: request.originalDiagnosticId,
      originalFailureCode: request.originalFailureCode,
      confirmedAt: now,
    });
  }

  private async assertActiveExtensionGate(
    base: ResearchPacket,
    topicId: string,
  ) {
    const event = await this.deps.events.get(base.approvedEventId);
    const queue = await this.deps.events.queue(topicId);
    if (
      !event ||
      event.status !== "ready" ||
      event.topicId !== topicId ||
      !queue ||
      queue.approvalStatus !== "approved" ||
      !["ready_for_research", "awaiting_source"].includes(
        queue.researchReadiness,
      ) ||
      (await this.deps.events.isCancelled(event)) ||
      !(await this.deps.events.isConsumed(event.id))
    )
      throw new Error("Topic approval gate is not active");
  }
  async findOfficialAlternatives(input: { topicId: string; url: string }) {
    const canonicalUrl = await validateManualUrl(input.url, this.deps.lookup);
    const target = new URL(canonicalUrl);
    const owner = ownerForHost(target.hostname);
    const discoveryUrls = [
      `${target.origin}/sitemap.xml`,
      `${target.origin}/blogs/journal.atom`,
      `${target.origin}/feed`,
    ];
    const robots = await this.deps.cache?.getRobots(target.hostname);
    const found = new Set<string>();
    for (const discoveryUrl of discoveryUrls) {
      if (robots && !robotsAllows(robots.body, new URL(discoveryUrl).pathname))
        continue;
      try {
        const document = await retrieveSafely(
          discoveryUrl,
          {
            ...this.deps.config,
            maxBytes: Math.min(this.deps.config.maxBytes, 512_000),
            maxRedirects: 1,
          },
          this.deps.fetch,
          this.deps.lookup,
          this.retrievalPolicyHooks(),
        );
        for (const candidate of extractOfficialAlternateUrls({
          body: document.body,
          contentType: document.contentType,
          documentUrl: document.finalUrl,
          publisherOwner: owner,
          targetUrl: canonicalUrl,
        }))
          found.add(candidate);
      } catch {
        // A discovery document is optional. Policy hooks retain the bounded
        // outcome and prevent repeated host access.
      }
      if (found.size >= 5) break;
    }
    const retrievable: string[] = [];
    for (const candidate of [...found].slice(0, 5)) {
      try {
        await this.inspectSource({ topicId: input.topicId, url: candidate });
        retrievable.push(candidate);
      } catch {
        // Candidates remain suggestions only if normal inspection succeeds.
      }
    }
    return retrievable;
  }
  private async run(
    eventId: string,
    recoverableStatuses?: readonly ResearchJob["status"][],
  ): Promise<ResearchPacket | undefined> {
    const event = await this.deps.events.get(eventId);
    if (!event || (await this.deps.events.isConsumed(eventId)))
      return undefined;
    await this.guard(event);
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    let job = await this.deps.jobs.claim(
      event.id,
      event.topicId,
      this.deps.workerId ?? `worker-${process.pid}`,
      now,
      this.deps.config.abandonedClaimMinutes * 60_000,
      recoverableStatuses,
    );
    if (!job) return undefined;
    try {
      job = await this.stage(job, "resolving");
      const queue = await this.deps.events.queue(event.topicId);
      if (!queue) throw new Error("Approved queue snapshot is missing");
      const items = await this.resolve(event, queue);
      await this.guard(event);
      job = await this.stage(job, "retrieving");
      const sources: ResearchSource[] = [];
      for (const item of capSources(
        items,
        this.deps.config.maxSources,
        this.deps.config.maxPerPublisherGroup,
        this.deps.config,
      )) {
        await this.guard(event);
        const source = await this.collect(event, item);
        sources.push(source);
      }
      const packetSources = limitExcerpts(
        sources,
        this.deps.config.totalExcerptChars,
      );
      job = await this.stage(job, "analyzing");
      const result = analyze(
        event.topicId,
        packetSources,
        now,
        this.deps.config,
      );
      const version = await this.deps.packets.nextVersion(event.topicId);
      const assessmentSufficient =
        result.sufficiency.score >= this.deps.config.sufficiencyThreshold &&
        result.blockingReasons.length === 0;
      const sufficient =
        this.deps.config.mode === "deterministic" && assessmentSufficient;
      const packet = researchPacketSchema.parse({
        id: stable("packet", event.id),
        version,
        topicId: event.topicId,
        candidateId: event.candidateId,
        runId: event.runId,
        approvedEventId: event.id,
        origin: event.origin,
        approvedTitle: title(queue),
        approvedAngle: event.approvedAngle,
        editorialNotes: event.editorialNotes,
        createdAt: now,
        updatedAt: now,
        status:
          this.deps.config.mode === "assisted"
            ? "awaiting_assisted_synthesis"
            : sufficient
              ? "ready"
              : "insufficient",
        researchMode: "deterministic",
        scope: ["approved topic", "approved angle", "source-backed facts only"],
        executiveSummary: packetSources
          .map((x) => x.summary)
          .filter(Boolean)
          .slice(0, 3)
          .join(" "),
        timeline: result.timeline,
        facts: result.claims.filter(
          (x) => x.claimType === "fact" || x.claimType === "specification",
        ),
        interpretations: [],
        predictions: [],
        communityObservations: result.claims.filter(
          (x) => x.claimType === "community_observation",
        ),
        technicalDetails: result.claims
          .filter((x) => x.claimType === "specification")
          .map((x) => x.statement),
        productSpecifications: result.claims
          .filter((x) => x.claimType === "specification")
          .map((x) => ({
            name: "Mechanically extracted specification",
            value: x.statement,
            sourceIds: x.sourceIds,
          })),
        counterpoints: [],
        conflicts: result.conflicts,
        unknowns: [
          ...(result.claims.length
            ? []
            : ["Supported factual detail is still required"]),
          ...packetSources
            .filter((x) => !x.publishedAt)
            .map((x) => `Publication date is unknown for source ${x.id}`),
        ],
        sourceIndex: packetSources,
        primarySourceIds: packetSources
          .filter((x) => x.isPrimary)
          .map((x) => x.id),
        recommendedThesis: event.approvedAngle,
        recommendedArticleType:
          event.origin === "ranked" ? "news_analysis" : "unknown",
        recommendedStructure: [
          "Verified facts",
          "Timeline",
          "Technical details",
          "Counterpoints and unknowns",
        ],
        researchConfidence: Math.min(1, result.sufficiency.score / 100),
        researchSufficiency: result.sufficiency,
        sufficient,
        blockingReasons: result.blockingReasons,
        warnings: packetSources.flatMap((x) => x.warnings),
        contentHashes: [...new Set(packetSources.map((x) => x.contentHash))],
        provenance: {
          deterministic: true,
          promptVersion: "research-synthesis-v1",
        },
      });
      await this.guard(event);
      job = await this.stage(job, "persisting");
      await this.deps.packets.save(packet);
      if (packet.status === "ready" || packet.status === "insufficient")
        await this.deps.events.consume(
          event.id,
          packet.id,
          packet.version,
          now,
        );
      job = {
        ...job,
        status:
          packet.status === "awaiting_assisted_synthesis"
            ? "awaiting_assistance"
            : "completed",
        packetId: packet.id,
        packetVersion: packet.version,
        completedAt: now,
        heartbeatAt: now,
        version: job.version + 1,
      };
      await this.deps.jobs.save(job);
      return packet;
    } catch (error) {
      const at = (this.deps.now ?? (() => new Date()))().toISOString();
      const cancelled =
        error instanceof Error &&
        error.message.includes("cancelled or topic superseded");
      await this.deps.jobs.save({
        ...job,
        status: cancelled ? "cancelled" : "failed",
        heartbeatAt: at,
        errors: [
          ...job.errors,
          error instanceof Error ? error.message : String(error),
        ],
        version: job.version + 1,
      });
      throw error;
    }
  }
  private async collect(
    event: TopicApprovedEvent,
    item: SourceItem,
  ): Promise<ResearchSource>;
  private async collect(
    event: TopicApprovedEvent,
    item: SourceItem,
    metadata: ResearchSourceExtensionInput,
    persist: false,
  ): Promise<{ source: ResearchSource; text: string }>;
  private async collect(
    event: TopicApprovedEvent,
    item: SourceItem,
    metadata?: ResearchSourceExtensionInput,
    persist = true,
  ): Promise<ResearchSource | { source: ResearchSource; text: string }> {
    const cached = await this.deps.cache?.get(item.canonicalUrl);
    const currentTime = (this.deps.now ?? (() => new Date()))();
    if (
      cached &&
      currentTime.getTime() - Date.parse(cached.source.retrievedAt) <=
        this.deps.config.cacheTtlHours * 3_600_000
    ) {
      const source = researchSourceSchema.parse({
        ...cached.source,
        topicId: event.topicId,
        id: stable("source", `${event.topicId}:${cached.source.canonicalUrl}`),
        publisher: metadata?.publisher ?? cached.source.publisher,
        publisherGroup:
          metadata?.publisherOwner.toLowerCase() ??
          cached.source.publisherGroup,
        publisherOwner:
          metadata?.publisherOwner.toLowerCase() ??
          cached.source.publisherOwner,
        sourceType: metadata?.sourceType ?? cached.source.sourceType,
        authority: metadata?.authority ?? cached.source.authority,
        isPrimary:
          metadata?.authority === undefined
            ? cached.source.isPrimary
            : metadata.authority === "primary",
        extractionMethod: "cache",
        retrievedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
        warnings: [...cached.source.warnings, "Reused canonical URL cache"],
      });
      if (persist) await this.deps.sources.save(source, cached.text);
      return persist ? source : { source, text: cached.text };
    }
    const negative = await this.deps.cache?.getRetrievalOutcome(
      item.canonicalUrl,
      currentTime.toISOString(),
    );
    if (negative) {
      const source = this.metadataSource(
        event,
        item,
        `Retrieval blocked: ${negative.code}${negative.retryAt ? ` until ${negative.retryAt}` : ""}`,
        metadata,
      );
      if (persist) await this.deps.sources.save(source, "");
      return persist ? source : { source, text: "" };
    }
    const target = new URL(item.canonicalUrl);
    const policy = this.retrievalPolicyHooks();
    let robotsWarning: string | undefined;
    try {
      const cachedRobots = await this.deps.cache?.getRobots(target.hostname);
      let robotsBody =
        cachedRobots &&
        currentTime.getTime() - Date.parse(cachedRobots.fetchedAt) <=
          this.deps.config.robotsCacheTtlHours * 3_600_000
          ? cachedRobots.body
          : undefined;
      if (robotsBody === undefined) {
        const robots = await retrieveSafely(
          `${target.origin}/robots.txt`,
          {
            ...this.deps.config,
            maxBytes: Math.min(this.deps.config.maxBytes, 256_000),
            maxRedirects: 1,
          },
          this.deps.fetch,
          this.deps.lookup,
          policy,
        );
        robotsBody = robots.body;
        await this.deps.cache?.putRobots(
          target.hostname,
          robotsBody,
          currentTime.toISOString(),
        );
      }
      if (!robotsAllows(robotsBody, target.pathname)) {
        await this.deps.cache?.putRetrievalOutcome({
          host: target.hostname,
          canonicalUrl: item.canonicalUrl,
          code: "robots_denied",
          status: 0,
          recordedAt: currentTime.toISOString(),
          expiresAt: new Date(
            currentTime.getTime() +
              this.deps.config.robotsCacheTtlHours * 3_600_000,
          ).toISOString(),
        });
        const source = this.metadataSource(
          event,
          item,
          "Blocked by robots.txt (robots_denied)",
          metadata,
        );
        if (persist) await this.deps.sources.save(source, "");
        return persist ? source : { source, text: "" };
      }
    } catch {
      robotsWarning =
        "robots.txt unavailable; conservative direct retrieval used";
    }
    let fetched;
    try {
      fetched = await retrieveSafely(
        item.canonicalUrl,
        this.deps.config,
        this.deps.fetch,
        this.deps.lookup,
        policy,
      );
    } catch (error) {
      const reason =
        error instanceof ResearchRetrievalError && error.code
          ? `${error.code}: ${error.message}${error.retryAt ? `; retry at ${error.retryAt}` : ""}`
          : error instanceof Error
            ? error.message
            : "unknown error";
      const source = this.metadataSource(
        event,
        item,
        `Retrieval failed: ${reason}`,
        metadata,
      );
      if (persist) await this.deps.sources.save(source, "");
      return persist ? source : { source, text: "" };
    }
    const extracted =
      new URL(fetched.finalUrl).hostname === "api.github.com" &&
      fetched.contentType.includes("json")
        ? new GitHubJsonContentExtractor().extract(fetched.body, item.title)
        : extractDocument(fetched.body, fetched.contentType, item.title);
    const hash = contentHash(extracted.text || fetched.body);
    const metrics = {
      wordCount: extracted.text ? extracted.text.split(/\s+/).length : 0,
      paragraphCount: extracted.excerpts.length,
      headingCount: extracted.headings.length,
      metadataFields:
        Object.values(extracted.metadata).filter(Boolean).length +
        Number(Boolean(extracted.author)) +
        Number(Boolean(extracted.publishedAt)),
    };
    const extractionQuality = fetched.contentType.includes("pdf")
      ? "metadata_only"
      : metrics.wordCount >= 80 && metrics.paragraphCount >= 3
        ? "high"
        : metrics.wordCount >= 10 && metrics.paragraphCount >= 1
          ? "medium"
          : extracted.text
            ? "low"
            : "failed";
    const source = researchSourceSchema.parse({
      id: stable(
        "source",
        `${event.topicId}:${normalizeUrl(fetched.finalUrl)}`,
      ),
      topicId: event.topicId,
      sourceItemId: item.id,
      originalUrl: scrub(item.url),
      canonicalUrl: scrub(item.canonicalUrl),
      finalUrl: scrub(fetched.finalUrl),
      title: extracted.title,
      publisher: metadata?.publisher ?? item.sourceName,
      publisherGroup:
        metadata?.publisherOwner.toLowerCase() ??
        new URL(item.canonicalUrl).hostname.replace(/^www\./, ""),
      publisherOwner: metadata?.publisherOwner.toLowerCase(),
      sourceType: metadata?.sourceType ?? inferType(item),
      authority: item.authority,
      isPrimary: item.authority === "primary",
      author: extracted.author ?? item.author,
      publishedAt: extracted.publishedAt ?? item.publishedAt,
      retrievedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      contentType: fetched.contentType,
      language: item.language,
      contentHash: hash,
      extractionMethod: fetched.contentType.includes("pdf")
        ? "metadata"
        : fetched.contentType.includes("html")
          ? "html"
          : fetched.contentType.includes("json")
            ? "json"
            : fetched.contentType.includes("xml")
              ? "xml"
              : "text",
      extractionStatus: fetched.contentType.includes("pdf")
        ? "metadata_only"
        : extracted.text
          ? "extracted"
          : "failed",
      extractionQuality,
      qualityMetrics: metrics,
      wordCount: metrics.wordCount,
      summary: [
        "[Mechanically extracted; not an editorial synthesis]",
        item.summary,
        extracted.headings.slice(0, 2).join("; "),
        extracted.excerpts[0],
      ]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 1200),
      selectedExcerpts: extracted.excerpts.map((text, i) => ({
        id: `excerpt_${hash.slice(0, 16)}_${i + 1}`,
        text: text.slice(0, this.deps.config.excerptChars),
        locator: `extracted paragraph ${i + 1}`,
        purpose: "factual support",
      })),
      licenseNotes:
        "Stored for private research; excerpts are deliberately limited.",
      warnings: [
        ...extracted.warnings,
        ...(robotsWarning ? [robotsWarning] : []),
      ],
      rawMetadata: {
        selectionReason:
          item.authority === "primary"
            ? "direct primary source"
            : item.authority === "community"
              ? "limited community context"
              : "independent corroboration",
        redirects: fetched.redirects.length - 1,
        ...extracted.metadata,
      },
    });
    if (persist) {
      await this.deps.sources.save(source, extracted.text);
      await this.deps.cache?.put(source, extracted.text);
    }
    return persist ? source : { source, text: extracted.text };
  }

  private retrievalPolicyHooks(): RetrievalPolicyHooks {
    const cache = this.deps.cache;
    if (!cache) return {};
    return {
      now: this.deps.now,
      beforeAttempt: ({ host, canonicalUrl, attemptedAt }) =>
        cache.claimRetrievalAttempt({
          host,
          canonicalUrl,
          attemptedAt,
          budget: this.deps.config.hostRetryBudget,
          windowMs: this.deps.config.hostRetryWindowMinutes * 60_000,
          cooldownMs: this.deps.config.hostCooldownMinutes * 60_000,
        }),
      recordOutcome: (outcome) => {
        const recorded = Date.parse(outcome.recordedAt);
        const expiresAt = new Date(
          Math.max(
            recorded + this.deps.config.negativeCacheTtlMinutes * 60_000,
            outcome.retryAt ? Date.parse(outcome.retryAt) : 0,
          ),
        ).toISOString();
        return cache.putRetrievalOutcome({ ...outcome, expiresAt });
      },
      clearOutcome: (host, canonicalUrl) =>
        cache.clearRetrievalOutcome(host, canonicalUrl),
    };
  }

  private metadataSource(
    event: TopicApprovedEvent,
    item: SourceItem,
    warning: string,
    metadata?: ResearchSourceExtensionInput,
  ): ResearchSource {
    const emptyHash = contentHash(`${item.title}\n${item.summary}`);
    return researchSourceSchema.parse({
      id: stable("source", `${event.topicId}:${item.canonicalUrl}`),
      topicId: event.topicId,
      sourceItemId: item.id,
      originalUrl: scrub(item.url),
      canonicalUrl: scrub(item.canonicalUrl),
      finalUrl: scrub(item.canonicalUrl),
      title: item.title,
      publisher: metadata?.publisher ?? item.sourceName,
      publisherGroup:
        metadata?.publisherOwner.toLowerCase() ??
        new URL(item.canonicalUrl).hostname.replace(/^www\./, ""),
      publisherOwner: metadata?.publisherOwner.toLowerCase(),
      sourceType: metadata?.sourceType ?? inferType(item),
      authority: item.authority,
      isPrimary: item.authority === "primary",
      author: item.author,
      publishedAt: item.publishedAt,
      retrievedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      contentType: "",
      language: item.language,
      contentHash: emptyHash,
      extractionMethod: "metadata",
      extractionStatus: "blocked",
      extractionQuality: "metadata_only",
      qualityMetrics: {
        wordCount: 0,
        paragraphCount: 0,
        headingCount: 0,
        metadataFields:
          Number(Boolean(item.publishedAt)) + Number(Boolean(item.author)),
      },
      wordCount: 0,
      summary: item.summary,
      selectedExcerpts: [],
      licenseNotes: "Metadata only; page content was not stored.",
      warnings: [warning],
      rawMetadata: {},
    });
  }
  private async resolve(event: TopicApprovedEvent, queue: TopicQueueItem) {
    const editorialItems = event.editorialNotes.flatMap((note) =>
      [...note.matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) =>
        manualItem(match[0].replace(/[),.;]+$/, ""), "Editorial-note source"),
      ),
    );
    if (queue.candidateSnapshot.kind === "manual_topic")
      return uniqueItems(editorialItems);
    if (queue.candidateSnapshot.kind === "manual_url") {
      const url = queue.candidateSnapshot.candidate.submittedUrl;
      if (!url) return [];
      return uniqueItems([
        manualItem(url, queue.candidateSnapshot.candidate.title),
        ...editorialItems,
      ]);
    }
    const ids = new Set(event.sourceItemIds);
    const approvedSources = event.sourceSnapshot?.length
      ? event.sourceSnapshot.map((source) => ({ ...source, rawMetadata: {} }))
      : (await this.deps.catalog.getRun(event.runId)).sourceItems;
    return uniqueItems([
      ...approvedSources
        .filter((x) => ids.has(x.id))
        .sort(
          (a, b) =>
            Number(b.authority === "primary") -
              Number(a.authority === "primary") ||
            a.sourceId.localeCompare(b.sourceId),
        ),
      ...editorialItems,
    ]);
  }
  private async guard(event: TopicApprovedEvent) {
    if (await this.deps.events.isCancelled(event))
      throw new Error("Research cancelled or topic superseded");
  }
  private async stage(job: ResearchJob, status: ResearchJob["status"]) {
    const next = {
      ...job,
      status,
      heartbeatAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      version: job.version + 1,
    };
    await this.deps.jobs.save(next);
    return next;
  }
}
function title(q: TopicQueueItem) {
  return q.candidateSnapshot.candidate.title;
}
function inferType(item: SourceItem): ResearchSource["sourceType"] {
  if (item.authority === "community") return "community_discussion";
  if (item.authority === "primary")
    return /release/i.test(item.title)
      ? "release_notes"
      : "official_announcement";
  return "technical_reporting";
}
function scrub(value: string) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()])
    if (/token|key|auth|secret|signature|session/i.test(key))
      url.searchParams.delete(key);
  return normalizeUrl(url.toString());
}
function manualItem(url: string, name: string): SourceItem {
  const canonicalUrl = normalizeUrl(url);
  return {
    id: stable("item", canonicalUrl),
    sourceId: "manual",
    sourceName: new URL(url).hostname,
    sourceType: "rss",
    authority: "independent",
    title: name,
    url,
    canonicalUrl,
    summary: "",
    retrievedAt: new Date(0).toISOString(),
    categories: [],
    tags: [],
    language: "en",
    rawMetadata: {},
    contentHash: createHash("sha256").update(name).digest("hex"),
  };
}

function capSources(
  items: SourceItem[],
  max: number,
  perGroup: number,
  config: ResearchConfig,
) {
  const counts = new Map<string, number>();
  const authorityCounts = new Map<string, number>();
  const selected: SourceItem[] = [];
  for (const item of items) {
    const group = new URL(item.canonicalUrl).hostname.replace(/^www\./, "");
    const count = counts.get(group) ?? 0;
    if (count >= perGroup) continue;
    const limit =
      item.authority === "primary"
        ? config.maxPrimarySources
        : item.authority === "community"
          ? config.maxCommunitySources
          : config.maxIndependentSources;
    const authorityCount = authorityCounts.get(item.authority) ?? 0;
    if (authorityCount >= limit) continue;
    counts.set(group, count + 1);
    authorityCounts.set(item.authority, authorityCount + 1);
    selected.push(item);
    if (selected.length >= max) break;
  }
  return selected;
}

function uniqueItems(items: SourceItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.canonicalUrl)) return false;
    seen.add(item.canonicalUrl);
    return true;
  });
}

function limitExcerpts(sources: ResearchSource[], totalCharacters: number) {
  let remaining = totalCharacters;
  return sources.map((source) => ({
    ...source,
    selectedExcerpts: source.selectedExcerpts.flatMap((excerpt) => {
      if (remaining <= 0) return [];
      const text = excerpt.text.slice(0, remaining);
      remaining -= text.length;
      return text ? [{ ...excerpt, text }] : [];
    }),
  }));
}

export const researchSourceExtensionInputSchema = z
  .object({
    topicId: z.string().min(1),
    url: z.string().url(),
    authority: researchSourceSchema.shape.authority,
    sourceType: researchSourceSchema.shape.sourceType,
    publisher: z.string().trim().min(1).max(200),
    publisherOwner: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  })
  .strict();
export type ResearchSourceExtensionInput = z.infer<
  typeof researchSourceExtensionInputSchema
>;

const primarySourceTypes = new Set<ResearchSource["sourceType"]>([
  "official_announcement",
  "documentation",
  "release_notes",
  "repository",
  "product_page",
  "support_document",
  "regulatory_filing",
  "research_paper",
]);

function validateExtensionClassification(
  base: ResearchPacket,
  canonicalUrl: string,
  request: ResearchSourceExtensionInput,
) {
  const url = new URL(canonicalUrl);
  if (!new Set(["http:", "https:"]).has(url.protocol))
    throw new Error("Research source extensions require HTTP(S) URLs");
  const owner = request.publisherOwner.toLowerCase();
  if (!hostnameBelongsToOwner(url.hostname, owner))
    throw new Error("Publisher ownership is not supported by the source URL");
  if (
    request.authority === "primary" &&
    !primarySourceTypes.has(request.sourceType)
  )
    throw new Error("Primary authority is unsupported for this source type");
  if (
    request.authority === "independent" &&
    base.sourceIndex
      .filter((source) => source.authority === "primary")
      .some((source) => publisherOwnershipGroup(source) === owner)
  )
    throw new Error(
      "A source owned by the primary publisher cannot be classified independent",
    );
  if (
    request.authority === "community" &&
    request.sourceType !== "community_discussion"
  )
    throw new Error("Community authority requires community_discussion type");
}

function hostnameBelongsToOwner(hostname: string, owner: string) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (host === "github.blog") return owner === "github.com";
  return host === owner || host.endsWith(`.${owner}`);
}

function sameExtensionClassification(
  source: ResearchSource,
  request: ResearchSourceExtensionInput,
) {
  return (
    source.authority === request.authority &&
    source.sourceType === request.sourceType &&
    source.publisher === request.publisher &&
    publisherOwnershipGroup(source) === request.publisherOwner.toLowerCase()
  );
}

function extensionItem(
  canonicalUrl: string,
  request: ResearchSourceExtensionInput,
  now: string,
): SourceItem {
  return {
    id: stable("item", `source-extension:${canonicalUrl}`),
    sourceId: "research-source-extension",
    sourceName: request.publisher,
    sourceType: "rss",
    authority: request.authority,
    title: `Research source: ${new URL(canonicalUrl).hostname}`,
    url: canonicalUrl,
    canonicalUrl,
    summary: "",
    retrievedAt: now,
    categories: [],
    tags: [],
    language: "en",
    rawMetadata: {
      explicitSourceType: request.sourceType,
      explicitPublisherOwner: request.publisherOwner,
    },
    contentHash: createHash("sha256").update(canonicalUrl).digest("hex"),
  };
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

export class ResearchSourceInspectionError extends Error {
  constructor(
    readonly kind:
      | "duplicate"
      | "robots_denied"
      | "429_retry_after"
      | "429_cooldown"
      | "403_forbidden"
      | "retrieval",
    message: string,
    readonly retryAt?: string,
  ) {
    super(message);
    this.name = "ResearchSourceInspectionError";
  }
}

export class HumanEvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanEvidenceValidationError";
  }
}

function normalizeHumanEvidence(value: string) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function humanEvidenceExcerpts(
  topicId: string,
  evidenceRecordId: string,
  evidenceText: string,
) {
  const paragraphs = evidenceText
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((value) => value.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    for (let offset = 0; offset < paragraph.length; offset += 500)
      chunks.push(paragraph.slice(offset, offset + 500));
    if (chunks.length >= 8) break;
  }
  return chunks.slice(0, 8).map((text, index) => ({
    id: stable("excerpt", `${topicId}:${evidenceRecordId}:${index}:${text}`),
    text,
    locator: `Human evidence record ${evidenceRecordId}, excerpt ${index + 1}`,
    purpose: "Operator-supplied excerpt from the canonical official page",
  }));
}

function ownerForHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (host === "github.blog" || host.endsWith(".github.com"))
    return "github.com";
  const parts = host.split(".");
  const publicSuffix = parts.slice(-2).join(".");
  const multiPartSuffixes = new Set([
    "co.uk",
    "org.uk",
    "com.au",
    "net.au",
    "co.jp",
    "co.nz",
    "com.br",
    "com.sg",
  ]);
  return parts.length > 2
    ? parts.slice(multiPartSuffixes.has(publicSuffix) ? -3 : -2).join(".")
    : host;
}

function publisherForOwner(owner: string) {
  const label = owner.split(".")[0] ?? owner;
  return label
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferExtensionType(url: string): ResearchSource["sourceType"] {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();
  if (parsed.hostname.startsWith("docs.")) return "documentation";
  if (/\/(?:docs?|documentation)\//.test(path)) return "documentation";
  if (/\/(?:support|help)\//.test(path)) return "support_document";
  if (/\/(?:changelog|releases?)\//.test(path)) return "release_notes";
  if (/\/(?:products?|store)\//.test(path)) return "product_page";
  return "official_announcement";
}

function ownershipMatchesTopic(base: ResearchPacket, owner: string) {
  if (
    base.sourceIndex.some(
      (source) =>
        source.authority === "primary" &&
        publisherOwnershipGroup(source) === owner,
    )
  )
    return true;
  const brand = owner.split(".")[0]?.replace(/[^a-z0-9]/g, "") ?? "";
  const topic = `${base.approvedTitle} ${base.approvedAngle}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return brand.length >= 3 && topic.includes(brand);
}
