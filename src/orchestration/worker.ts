import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { FeedAdapter } from "../discovery/adapters/feed-adapter";
import { HackerNewsAdapter } from "../discovery/adapters/hacker-news-adapter";
import { loadSourceConfig } from "../discovery/config/source-config";
import { runDiscovery } from "../discovery/discovery-service";
import { applyEditorialInterests } from "../interests/ranking";
import { PostgresEditorialInterestRepository } from "../interests/repository";
import {
  createConfiguredLlmProvider,
  LlmProviderConfigurationError,
  type LLMProvider,
} from "../llm/provider";
import { GitHubContentRepository } from "../publication/repository";
import {
  HttpPublicPageVerifier,
  VercelGitDeploymentProvider,
  VercelGitHubDeploymentProvider,
} from "../publication/deployment";
import { loadPublicationConfig } from "../publication/config";
import { PublicationService } from "../publication/service";
import {
  DirectProductionVerificationService,
  PostgresDirectProductionArtifactRepository,
} from "../publication/production-verification";
import { PostgresHistoryRepository } from "../ranking/postgres-history";
import { loadRankingConfig } from "../ranking/config";
import { runRankingPipeline } from "../ranking/service";
import {
  importAssistance,
  repairPrimaryBlockingState,
  writeAssistanceTask,
} from "../research/assisted";
import { DurableApprovedEventError } from "../research/approved-event";
import { loadResearchConfig } from "../research/config";
import { assistedResearchResultSchema } from "../research/models";
import { hasVerifiedPrimaryEvidence } from "../research/primary-evidence";
import { ResearchService } from "../research/service";
import {
  PostgresResearchRemediationRepository,
  ResearchRemediationService,
  ResearchRemediationTelegramController,
  researchRemediationCallbackSecret,
  shouldIssueBlockedRemediationCard,
} from "../research/remediation";
import { loadReviewConfig } from "../review/config";
import { FinalApprovalService } from "../review/final-approval";
import {
  editorialReviewImportSchema,
  revisionResultSchema,
} from "../review/models";
import { PreviewService } from "../review/preview";
import { createRemotePreviewUrl } from "../review/preview-url";
import { RevisionService } from "../review/revision";
import { ReviewService } from "../review/service";
import { FinalReviewTelegramController } from "../review/telegram";
import {
  createRepositoryComposition,
  type RepositoryComposition,
} from "../storage/composition";
import { requireTelegramRuntimeConfig } from "../telegram/config";
import { topicQueueItemSchema } from "../telegram/models";
import { TopicApprovalService } from "../telegram/service";
import { TelegramBotApiClient } from "../telegram/telegram-client";
import { loadWritingConfig } from "../writing/config";
import { articleWritingResultSchema } from "../writing/models";
import { WritingService } from "../writing/service";
import { canonicalJsonHash, sha256 } from "../writing/task";
import type { AutomationJob } from "./models";
import { reconcileAutomationQueue } from "./reconcile";
import { PostgresAutomationJobRepository } from "./repository";
import {
  InvalidResearchHandoffError,
  loadResearchHandoff,
} from "./research-handoff";

export class AutomationWorker {
  private readonly jobs: PostgresAutomationJobRepository;
  private readonly provider: LLMProvider;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly telegramConfig;
  private readonly telegram: TelegramBotApiClient;

  constructor(
    private readonly composition: RepositoryComposition,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    options: { provider?: LLMProvider; workerId?: string } = {},
  ) {
    if (!composition.sql)
      throw new Error("Automation worker requires PostgreSQL storage");
    this.jobs = new PostgresAutomationJobRepository(composition.sql);
    this.provider =
      options.provider ??
      createConfiguredLlmProvider(environment, composition.sql);
    this.workerId =
      options.workerId ?? `worker-${process.env.GITHUB_RUN_ID ?? process.pid}`;
    this.leaseMs = Number(environment.AUTOMATION_LEASE_MINUTES ?? 30) * 60_000;
    this.telegramConfig = requireTelegramRuntimeConfig(environment, "api");
    this.telegram = new TelegramBotApiClient({
      botToken: this.telegramConfig.TELEGRAM_BOT_TOKEN as string,
    });
  }

  async reconcile() {
    if (!this.composition.sql)
      throw new Error("PostgreSQL storage is required");
    const result = await reconcileAutomationQueue(
      this.composition.sql,
      this.jobs,
    );
    const notifiedResearchBlocks = await this.notifyExistingResearchBlocks();
    await this.jobs.heartbeatComponent({
      component: "scheduler",
      instanceId: this.environment.GITHUB_RUN_ID
        ? `github-actions-${this.environment.GITHUB_RUN_ID}`
        : this.workerId,
      status: "healthy",
      details: {
        source:
          this.environment.GITHUB_ACTIONS === "true"
            ? "github_actions"
            : "worker_command",
        event: this.environment.GITHUB_EVENT_NAME ?? "local",
        reconciled: result.enqueued.length,
        notifiedResearchBlocks,
      },
      observedAt: new Date().toISOString(),
    });
    return result;
  }

  async drain(
    maximum = Number(this.environment.AUTOMATION_MAX_JOBS_PER_RUN ?? 4),
  ) {
    const completed: { id: string; type: string; status: string }[] = [];
    await this.jobs.heartbeatComponent({
      component: "worker",
      instanceId: this.workerId,
      status: "healthy",
      details: { phase: "starting" },
      observedAt: new Date().toISOString(),
    });
    for (let count = 0; count < maximum; count += 1) {
      const job = await this.jobs.claim(this.workerId, this.leaseMs);
      if (!job) break;
      const timer = setInterval(
        () => void this.jobs.heartbeat(job.id, this.workerId, this.leaseMs),
        Math.min(60_000, this.leaseMs / 3),
      );
      timer.unref();
      try {
        const result = await this.run(job);
        await this.jobs.succeed(job.id, this.workerId, result);
        completed.push({ id: job.id, type: job.type, status: "succeeded" });
      } catch (error) {
        const classification = classify(error);
        const failed = await this.jobs.fail(
          job.id,
          this.workerId,
          classification,
        );
        completed.push({ id: job.id, type: job.type, status: failed.status });
        await this.notifyFailure(
          failed,
          failed.diagnosticId ?? "unknown",
          classification.summary,
          classification.operatorAction,
        );
      } finally {
        clearInterval(timer);
      }
      await this.reconcile();
    }
    await this.jobs.heartbeatComponent({
      component: "worker",
      instanceId: this.workerId,
      status: "healthy",
      details: { completed: completed.length },
      observedAt: new Date().toISOString(),
    });
    return completed;
  }

  private run(job: AutomationJob): Promise<Record<string, unknown>> {
    switch (job.type) {
      case "discovery":
        return this.discovery(job);
      case "research":
        return this.research(job);
      case "writing":
        return this.writing(job);
      case "editorial_review":
        return this.review(job);
      case "revision":
        return this.revision(job);
      case "publication":
        return this.publication(job);
      case "reconciliation":
        return this.reconcile();
      default:
        throw new BlockedAutomationError(
          `Unsupported worker job type: ${job.type}`,
        );
    }
  }

  private async discovery(job: AutomationJob) {
    const runId = stringPayload(job, "runId");
    const windowEnd =
      optionalStringPayload(job, "windowEnd") ?? new Date().toISOString();
    const windowStart =
      optionalStringPayload(job, "windowStart") ??
      new Date(
        new Date(windowEnd).getTime() - 7 * 24 * 60 * 60_000,
      ).toISOString();
    const sources = await loadSourceConfig(
      this.environment.DISCOVERY_CONFIG ??
        "automation/config/sources.example.yaml",
    );
    await runDiscovery({
      runId,
      config: sources,
      adapters: [new FeedAdapter(), new HackerNewsAdapter()],
      fetch,
      artifactRepository: this.composition.artifacts,
      windowStart,
      windowEnd,
    });
    if (!this.composition.sql)
      throw new Error("PostgreSQL storage is required");
    const baseRankingConfig = await loadRankingConfig(
      this.environment.RANKING_CONFIG ??
        "automation/config/ranking.example.yaml",
    );
    const interests = new PostgresEditorialInterestRepository(
      this.composition.sql,
    );
    const ranking = await runRankingPipeline({
      runId,
      config: applyEditorialInterests(
        baseRankingConfig,
        await interests.list(),
      ),
      history: new PostgresHistoryRepository(this.composition.sql),
      artifactRepository: this.composition.artifacts,
    });
    const topics = new TopicApprovalService({
      adapter: this.telegram,
      repository: this.composition.telegram,
      catalog: this.composition.catalog,
      config: this.telegramConfig,
    });
    for (const chatId of this.telegramConfig.TELEGRAM_ALLOWED_CHAT_IDS)
      await topics.showTopics(
        chatId,
        runId,
        true,
        job.payload.scheduled === true
          ? "scheduled"
          : job.payload.manual === true && job.payload.test === true
            ? "manual_test"
            : "other",
      );
    return {
      runId,
      ranked: ranking.ranked.length,
      notifiedChats: this.telegramConfig.TELEGRAM_ALLOWED_CHAT_IDS.length,
      windowStart,
      windowEnd,
    };
  }

  private async research(job: AutomationJob) {
    if (job.payload.remediationAction === "retry_source") {
      const { controller } = await this.remediationController();
      return controller.processScheduledRetry(job);
    }
    const approvedEvent = await loadResearchHandoff(
      job,
      this.composition.research.events,
    );
    const eventId = approvedEvent.id;
    const config = await loadResearchConfig(
      this.environment.RESEARCH_CONFIG ??
        "automation/config/research.example.yaml",
    );
    const repositories = this.composition.research;
    const service = new ResearchService({
      events: repositories.events,
      jobs: repositories.jobs,
      packets: repositories.packets,
      sources: repositories.sources,
      cache: repositories.cache,
      extensions: repositories.extensions,
      humanEvidence: repositories.humanEvidence,
      catalog: this.composition.catalog,
      config,
      workerId: this.workerId,
    });
    const repairPrimaryBlock = job.payload.repairPrimaryBlock === true;
    let packet = repairPrimaryBlock
      ? await repositories.packets.get(
          approvedEvent.topicId,
          numberPayload(job, "packetVersion"),
        )
      : await service.process(eventId);
    if (!packet) {
      const event = await repositories.events.get(eventId);
      packet = event
        ? await repositories.packets.get(
            event.topicId,
            typeof job.payload.packetVersion === "number"
              ? job.payload.packetVersion
              : undefined,
          )
        : undefined;
    }
    if (!packet) throw new Error("Research produced no durable packet");
    if (repairPrimaryBlock)
      packet = await repairPrimaryBlockingState(packet, repositories.packets);
    if (packet.status === "awaiting_assisted_synthesis") {
      await writeAssistanceTask(
        packet,
        this.environment.RESEARCH_TASK_DIRECTORY ?? "data/tasks/research",
        "prompts/research-synthesis.md",
        repositories.tasks,
      );
      const task = await repositories.tasks.readInput(
        packet.topicId,
        packet.version,
      );
      const generated = await this.provider.generate({
        jobId: job.id,
        stage: "research",
        system:
          "Synthesize only the supplied evidence. Every interpretation or prediction must cite existing source and excerpt IDs. Preserve unresolved uncertainty.",
        task: withSchema(task, assistedResearchResultSchema, {
          generatedAt: new Date().toISOString(),
        }),
        schema: assistedResearchResultSchema,
      });
      packet = await withTemporaryJson(generated.value, (path) =>
        importAssistance(
          path,
          repositories.packets,
          repositories.events,
          undefined,
          repositories.imports,
        ),
      );
    }
    if (hasVerifiedPrimaryEvidence(packet)) {
      const queue = await this.composition.telegram.getQueueItem(
        packet.topicId,
      );
      if (queue?.researchReadiness === "awaiting_source")
        await this.composition.telegram.saveQueueItem(
          topicQueueItemSchema.parse({
            ...queue,
            researchReadiness: "ready_for_research",
            updatedAt: new Date().toISOString(),
            version: queue.version + 1,
          }),
          queue.version,
        );
    }
    if (packet.status !== "ready" || !packet.sufficient)
      throw new BlockedAutomationError(
        `Research blocked: ${packet.blockingReasons.join("; ") || "evidence threshold was not met"}`,
        packet.blockingReasons.some((reason) => /primary source/i.test(reason))
          ? "Do not retry unchanged. In Telegram, run /topics and approve a different topic whose source preview includes a primary source."
          : "Do not retry unchanged. Add the missing evidence or choose a different topic.",
      );
    return {
      topicId: packet.topicId,
      packetId: packet.id,
      packetVersion: packet.version,
      sourceCount: packet.sourceIndex.length,
    };
  }

  private async writing(job: AutomationJob) {
    const topicId = requiredTopic(job);
    const researchVersion = numberPayload(job, "researchVersion");
    const config = await loadWritingConfig(
      this.environment.WRITING_CONFIG ??
        "automation/config/writing.example.yaml",
    );
    const repositories = this.composition.writing;
    const service = new WritingService({
      packets: this.composition.research.packets,
      jobs: repositories.jobs,
      drafts: repositories.drafts,
      quality: repositories.quality,
      history: repositories.history,
      tasks: repositories.tasks,
      gates: repositories.gates,
      config,
      configHash: sha256(JSON.stringify(config)),
      workerId: this.workerId,
      paths: {
        prompt: "prompts/article-writer.md",
        audience: "brand/audience.md",
        style: "brand/writing-style.md",
        editorial: "brand/editorial-rules.md",
        design: "brand/design-style.md",
        template: "templates/article.mdx",
      },
    });
    const prepared = await service.prepare(topicId, researchVersion);
    const task = await repositories.tasks.readInput(topicId, researchVersion);
    const generated = await this.provider.generate({
      jobId: job.id,
      stage: "writing",
      system:
        "Write one complete source-grounded article. Use citation markers exactly as required. Every claimReferences[].section must exactly match an H2-H4 heading in mdx. Attach a source to a claim reference only when that research claim lists the source in its sourceIds. Keep facts, analysis, opinion, and predictions distinct. Do not claim hands-on experience.",
      task: withSchema(task, articleWritingResultSchema, {
        taskHash: prepared.job.taskHash,
      }),
      schema: articleWritingResultSchema,
    });
    const imported = await withTemporaryJson(generated.value, (path) =>
      service.import(topicId, researchVersion, path),
    );
    return {
      topicId,
      draftId: imported.draft.id,
      draftVersion: imported.draft.version,
      quality: imported.quality?.status,
    };
  }

  private async review(job: AutomationJob) {
    const topicId = requiredTopic(job);
    const draftVersion = numberPayload(job, "draftVersion");
    const services = await this.reviewServices();
    const existingReview = await services.review.report(topicId, draftVersion);
    const existingIssueIds = existingReview
      ? revisionIssueIdsForDecision(
          existingReview.decision,
          existingReview.issues,
        )
      : [];
    if (existingReview && existingIssueIds.length) {
      await services.revision.prepare(topicId, draftVersion, existingIssueIds, {
        origin: "editorial_review",
      });
      return {
        topicId,
        decision: existingReview.decision,
        reviewVersion: existingReview.version,
        reusedReview: true,
        revisionQueued: true,
        issueCount: existingIssueIds.length,
      };
    }
    const prepared = await services.review.prepare(topicId, draftVersion);
    const task = await this.composition.review.tasks.readInput(
      topicId,
      draftVersion,
    );
    const generated = await this.provider.generate({
      jobId: job.id,
      stage: "editorial_review",
      system:
        "Perform a rigorous evidence-bound editorial review. Deterministic blockers are authoritative. Every issue ID must be deterministic-looking and all referenced source/claim IDs must already exist. For each issue, either leave section null or copy it exactly from allowedArticleSections.",
      task: withSchema(task, editorialReviewImportSchema, {
        requiredIdentity: {
          id: `review_${sha256(`${(task as { draftId?: string })?.draftId}:${draftVersion}`).slice(0, 24)}`,
          taskHash: prepared.job.taskHash,
          createdAt: new Date().toISOString(),
        },
      }),
      schema: editorialReviewImportSchema,
    });
    const imported = await withTemporaryJson(generated.value, (path) =>
      services.review.import(topicId, draftVersion, path),
    );
    const issueIds = revisionIssueIdsForDecision(
      imported.review.decision,
      imported.review.issues,
    );
    if (issueIds.length) {
      await services.revision.prepare(topicId, draftVersion, issueIds, {
        origin: "editorial_review",
      });
      return {
        topicId,
        decision: imported.review.decision,
        revisionQueued: true,
        issueCount: issueIds.length,
      };
    }
    if (imported.review.decision === "block")
      throw new BlockedAutomationError(
        `Editorial review blocked without an actionable open issue: ${imported.review.summary}`,
      );
    await services.preview.create(topicId, draftVersion);
    for (const [
      index,
      chatId,
    ] of this.telegramConfig.TELEGRAM_ALLOWED_CHAT_IDS.entries()) {
      const userId =
        this.telegramConfig.TELEGRAM_ALLOWED_USER_IDS[index] ??
        this.telegramConfig.TELEGRAM_ALLOWED_USER_IDS[0];
      if (userId) await services.controller.notify(topicId, chatId, userId);
    }
    return {
      topicId,
      decision: imported.review.decision,
      reviewVersion: imported.review.version,
      finalReviewSent: true,
    };
  }

  private async revision(job: AutomationJob) {
    const topicId = requiredTopic(job);
    const draftVersion = numberPayload(job, "draftVersion");
    const services = await this.reviewServices();
    const task = await this.composition.review.revisions.readInput(
      topicId,
      draftVersion,
    );
    if (!task) throw new Error("Prepared revision input is missing");
    const taskHash = canonicalJsonHash(task);
    const generated = await this.provider.generate({
      jobId: job.id,
      stage: "revision",
      system:
        "Apply only the requested revision scope. Copy topicId, sourceDraftId, sourceDraftVersion, and revisionScope exactly from the task; set provenance.taskHash to requiredTaskHash exactly. Preserve protected claims and required source IDs. Return the complete revised MDX body when body changes are allowed.",
      task: withSchema(task, revisionResultSchema, {
        requiredTaskHash: taskHash,
        requiredIdentity: {
          topicId: (task as { topicId?: string }).topicId,
          sourceDraftId: (task as { sourceDraftId?: string }).sourceDraftId,
          sourceDraftVersion: (task as { sourceDraftVersion?: number })
            .sourceDraftVersion,
          revisionScope: (task as { request?: { scope?: string } }).request
            ?.scope,
        },
      }),
      schema: revisionResultSchema,
    });
    const normalized = normalizeRevisionIdentity(
      generated.value,
      task,
      taskHash,
    );
    const imported = await withTemporaryJson(normalized, (path) =>
      services.revision.import(topicId, draftVersion, path),
    );
    return {
      topicId,
      sourceDraftVersion: draftVersion,
      draftVersion: imported.draft.version,
      quality: imported.quality?.status,
    };
  }

  private async publication(job: AutomationJob) {
    const eventId = stringPayload(job, "eventId");
    const config = await loadPublicationConfig(
      this.environment.PUBLICATION_CONFIG ??
        "automation/config/publication.production.yaml",
    );
    if (
      config.mode !== "github" ||
      config.branchStrategy !== "direct" ||
      config.deploymentProvider !== "vercel_git" ||
      config.deploymentPolicy !== "required"
    )
      throw new BlockedAutomationError(
        "Production publication config must use github/direct/vercel_git/required",
      );
    const repository = new GitHubContentRepository({
      token: this.environment.BLOG_GITHUB_TOKEN ?? "",
      repository: this.environment.BLOG_REPOSITORY ?? config.repository,
      defaultBranch:
        this.environment.BLOG_DEFAULT_BRANCH ?? config.defaultBranch,
    });
    const deployment =
      this.environment.VERCEL_DEPLOYMENT_METADATA_SOURCE === "github"
        ? new VercelGitHubDeploymentProvider({
            token: this.environment.BLOG_GITHUB_TOKEN ?? "",
            repository: config.repository,
          })
        : new VercelGitDeploymentProvider({
            token: this.environment.VERCEL_TOKEN ?? "",
            projectId: this.environment.VERCEL_PROJECT_ID ?? "",
            teamId: this.environment.VERCEL_TEAM_ID,
          });
    const service = new PublicationService({
      events: this.composition.publication.events,
      jobs: this.composition.publication.jobs,
      publications: this.composition.publication.publications,
      consumption: this.composition.publication.consumption,
      deployments: this.composition.publication.deployments,
      verifications: this.composition.publication.verifications,
      drafts: this.composition.writing.drafts,
      quality: this.composition.writing.quality,
      packets: this.composition.research.packets,
      reviews: this.composition.review.reviews,
      approvals: this.composition.review.approvals,
      gates: this.composition.review.gates,
      repository,
      deployment,
      publicPage: new HttpPublicPageVerifier({ retries: 3 }),
      config,
      tasks: this.composition.publication.tasks,
    });
    const result = await service.event(eventId, this.workerId, false);
    const publication = result.publication;
    if (!publication) throw new Error("Publication produced no durable record");
    if (publication.status !== "published")
      throw new Error(`Publication ended in ${publication.status}`);
    if (!this.composition.sql)
      throw new Error("PostgreSQL storage is required");
    const verified = await new DirectProductionVerificationService({
      publications: this.composition.publication.publications,
      artifacts: new PostgresDirectProductionArtifactRepository(
        this.composition.sql,
      ),
      repository,
      deployment,
      config,
    }).verify(publication.id);
    for (const chatId of this.telegramConfig.TELEGRAM_ALLOWED_CHAT_IDS)
      await this.telegram.sendStatusMessage(
        chatId,
        `<b>Published ✓</b>\n${escape(publication.title)}\n${escape(publication.canonicalUrl)}\nCommit ${publication.commitSha.slice(0, 12)} · production verified\n\nSocial distribution is available separately.`,
      );
    return {
      publicationId: publication.id,
      canonicalUrl: publication.canonicalUrl,
      commitSha: publication.commitSha,
      contentHash: publication.contentHash,
      productionArtifactId: verified.artifact.id,
      verified: true,
    };
  }

  private async reviewServices() {
    const config = await loadReviewConfig(
      this.environment.REVIEW_CONFIG ?? "automation/config/review.example.yaml",
    );
    const writingConfig = await loadWritingConfig(
      this.environment.WRITING_CONFIG ??
        "automation/config/writing.example.yaml",
    );
    const review = new ReviewService({
      drafts: this.composition.writing.drafts,
      quality: this.composition.writing.quality,
      packets: this.composition.research.packets,
      jobs: this.composition.review.jobs,
      reviews: this.composition.review.reviews,
      tasks: this.composition.review.tasks,
      approvals: this.composition.review.approvals,
      gates: this.composition.review.gates,
      config,
      workerId: this.workerId,
      paths: {
        reviewPrompt: "prompts/editorial-review.md",
        audience: "brand/audience.md",
        style: "brand/writing-style.md",
        editorial: "brand/editorial-rules.md",
      },
    });
    const revision = new RevisionService({
      drafts: this.composition.writing.drafts,
      quality: this.composition.writing.quality,
      history: this.composition.writing.history,
      packets: this.composition.research.packets,
      reviews: this.composition.review.reviews,
      tasks: this.composition.review.revisions,
      approvals: this.composition.review.approvals,
      events: this.composition.review.events,
      previews: this.composition.review.previews,
      gates: this.composition.review.gates,
      writingConfig,
    });
    const final = new FinalApprovalService({
      drafts: this.composition.writing.drafts,
      quality: this.composition.writing.quality,
      packets: this.composition.research.packets,
      reviews: this.composition.review.reviews,
      revisions: this.composition.review.revisions,
      approvals: this.composition.review.approvals,
      events: this.composition.review.events,
      gates: this.composition.review.gates,
      config,
    });
    const preview = new PreviewService({
      drafts: this.composition.writing.drafts,
      previews: this.composition.review.previews,
      gates: this.composition.review.gates,
      config,
    });
    const controller = new FinalReviewTelegramController({
      service: final,
      revision,
      reviews: this.composition.review.reviews,
      drafts: this.composition.writing.drafts,
      quality: this.composition.writing.quality,
      previews: this.composition.review.previews,
      approvals: this.composition.review.approvals,
      conversations: this.composition.review.conversations,
      adapter: this.telegram,
      callbackSecret: this.telegramConfig.callbackSecret,
      config,
      previewUrl: (value) => createRemotePreviewUrl(value, this.environment),
    });
    return { review, revision, final, preview, controller };
  }

  private async notifyFailure(
    job: AutomationJob,
    diagnosticId: string,
    summary: string,
    operatorAction?: string,
  ) {
    if (
      job.type === "research" &&
      job.status === "blocked" &&
      (/primary source/i.test(summary) ||
        typeof job.payload.remediationId === "string") &&
      this.composition.sql
    ) {
      try {
        const { controller } = await this.remediationController();
        for (const [
          index,
          chatId,
        ] of this.telegramConfig.TELEGRAM_ALLOWED_CHAT_IDS.entries()) {
          const userId =
            this.telegramConfig.TELEGRAM_ALLOWED_USER_IDS[index] ??
            this.telegramConfig.TELEGRAM_ALLOWED_USER_IDS[0];
          if (userId)
            await controller.notifyBlocked(
              job,
              { chatId, userId, chatType: "private" },
              summary,
            );
        }
        return;
      } catch {
        // Fall through to the safe generic failure notification. Detailed
        // diagnostics already remain attached to the durable automation job.
      }
    }
    const safe = summary
      .replace(/https?:\/\/[^\s]+/g, "[redacted URL]")
      .slice(0, 500);
    for (const chatId of this.telegramConfig.TELEGRAM_ALLOWED_CHAT_IDS)
      await this.telegram
        .sendStatusMessage(
          chatId,
          `<b>${escape(job.type)} failed</b>\n${escape(safe)}\nReference: ${escape(diagnosticId)}\n${escape(operatorAction ?? `Use /retry ${job.id} after correcting readiness, or /system_status.`)}`,
        )
        .catch(() => undefined);
  }

  private async notifyExistingResearchBlocks() {
    if (!this.composition.sql) return 0;
    const { controller, repository, service } =
      await this.remediationController();
    const actionable = await service.listActionableBlocked();
    if (!actionable.length) return 0;
    let sent = 0;
    for (const { job } of actionable)
      for (const [
        index,
        chatId,
      ] of this.telegramConfig.TELEGRAM_ALLOWED_CHAT_IDS.entries()) {
        const userId =
          this.telegramConfig.TELEGRAM_ALLOWED_USER_IDS[index] ??
          this.telegramConfig.TELEGRAM_ALLOWED_USER_IDS[0];
        if (!userId) continue;
        const existing = await repository.getForJobActor(
          job.id,
          chatId,
          userId,
        );
        // Reissue one legacy v1 card after it expires. The newly issued card is
        // v2, so later scheduled runs skip it and cannot create reminder spam.
        if (!shouldIssueBlockedRemediationCard(existing, new Date())) continue;
        await controller.notifyBlocked(
          job,
          { chatId, userId, chatType: "private" },
          job.failureSummary,
        );
        sent += 1;
      }
    return sent;
  }

  private async remediationController() {
    if (!this.composition.sql)
      throw new Error("Research remediation requires PostgreSQL storage");
    const config = await loadResearchConfig(
      this.environment.RESEARCH_CONFIG ??
        "automation/config/research.example.yaml",
    );
    const repository = new PostgresResearchRemediationRepository(
      this.composition.sql,
    );
    const research = new ResearchService({
      events: this.composition.research.events,
      jobs: this.composition.research.jobs,
      packets: this.composition.research.packets,
      sources: this.composition.research.sources,
      cache: this.composition.research.cache,
      extensions: this.composition.research.extensions,
      humanEvidence: this.composition.research.humanEvidence,
      catalog: this.composition.catalog,
      config,
    });
    const service = new ResearchRemediationService({
      remediation: repository,
      research,
      packets: this.composition.research.packets,
      events: this.composition.research.events,
      topics: this.composition.telegram,
      jobs: this.jobs,
      ttlMinutes: this.telegramConfig.TELEGRAM_CONVERSATION_TTL_MINUTES,
    });
    const controller = new ResearchRemediationTelegramController({
      service,
      repository,
      adapter: this.telegram,
      callbackSecret: researchRemediationCallbackSecret(
        this.telegramConfig.TELEGRAM_BOT_TOKEN as string,
      ),
      cancelTopic: async () => {
        throw new Error("Cancellation is available through the webhook");
      },
      refreshTopics: async () => undefined,
    });
    return { controller, repository, service };
  }
}

export function revisionIssueIdsForDecision(
  decision: "pass" | "pass_with_warnings" | "revise" | "block",
  issues: Array<{ id: string; status: string }>,
) {
  if (!["revise", "block"].includes(decision)) return [];
  return issues
    .filter((issue) => issue.status === "open")
    .map((issue) => issue.id);
}

export function normalizeRevisionIdentity(
  value: unknown,
  task: unknown,
  taskHash: string,
) {
  const prepared = z
    .object({
      topicId: z.string(),
      sourceDraftId: z.string(),
      sourceDraftVersion: z.number().int().positive(),
      request: z.object({ scope: revisionResultSchema.shape.revisionScope }),
    })
    .passthrough()
    .parse(task);
  const generated = z.record(z.string(), z.unknown()).parse(value);
  return revisionResultSchema.parse({
    ...generated,
    topicId: prepared.topicId,
    sourceDraftId: prepared.sourceDraftId,
    sourceDraftVersion: prepared.sourceDraftVersion,
    revisionScope: prepared.request.scope,
    provenance: {
      mode: "manual_claude_code",
      taskHash,
    },
  });
}

export async function runAutomationWorker(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const composition = createRepositoryComposition(environment);
  try {
    await composition.verify();
    const worker = new AutomationWorker(composition, environment);
    await worker.reconcile();
    return await worker.drain();
  } finally {
    await composition.close();
  }
}

class BlockedAutomationError extends Error {
  constructor(
    message: string,
    readonly operatorAction?: string,
  ) {
    super(message);
    this.name = "BlockedAutomationError";
  }
}

function classify(error: unknown) {
  const summary =
    error instanceof Error ? error.message : "Unknown automation failure";
  const missingCredential =
    /(?:required|not configured|missing).*(?:key|token|credential)|GOOGLE_AI_API_KEY/i.test(
      summary,
    );
  const blocked =
    error instanceof BlockedAutomationError ||
    error instanceof InvalidResearchHandoffError ||
    error instanceof DurableApprovedEventError ||
    error instanceof LlmProviderConfigurationError ||
    missingCredential;
  const nonRetryable =
    /(?:identity|snapshot hash|unexpected|collision|unsafe|not eligible|maximum attempts)/i.test(
      summary,
    );
  return {
    code: blocked
      ? "READINESS_BLOCKED"
      : nonRetryable
        ? "SAFETY_REJECTED"
        : "TRANSIENT_FAILURE",
    summary,
    retryable: !blocked && !nonRetryable,
    blocked,
    operatorAction:
      error instanceof BlockedAutomationError
        ? error.operatorAction
        : error instanceof DurableApprovedEventError ||
            error instanceof InvalidResearchHandoffError
          ? "No retry is needed. This malformed historical lineage is blocked and retained for audit."
          : undefined,
  };
}

function withSchema<T>(
  task: unknown,
  schema: z.ZodType<T>,
  extra: Record<string, unknown>,
) {
  return {
    task,
    ...extra,
    outputJsonSchema: z.toJSONSchema(schema, { target: "draft-2020-12" }),
  };
}

async function withTemporaryJson<T>(
  value: unknown,
  operation: (path: string) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "acm-automation-"));
  const path = join(directory, "result.json");
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    return await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function stringPayload(job: AutomationJob, key: string) {
  const value = job.payload[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Automation payload is missing ${key}`);
  return value;
}

function optionalStringPayload(job: AutomationJob, key: string) {
  const value = job.payload[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberPayload(job: AutomationJob, key: string) {
  const value = job.payload[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error(`Automation payload is missing ${key}`);
  return value;
}

function requiredTopic(job: AutomationJob) {
  if (!job.topicId) throw new Error("Automation job is missing topic lineage");
  return job.topicId;
}

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
