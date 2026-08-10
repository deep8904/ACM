import type { WorkflowArtifactRepository } from "../database/artifacts";
import type {
  ArticleDraftRepository,
  DraftQualityRepository,
} from "../writing/interfaces";
import type { ResearchPacketRepository } from "../research/interfaces";
import type {
  EditorialReviewRepository,
  FinalApprovalRepository,
  ReviewGateRepository,
} from "../review/interfaces";
import type { ArticleFinalApprovedEvent } from "../review/models";
import { sha256 } from "../writing/task";
import { inspectMdx } from "../writing/mdx";
import type { PublicationConfig } from "./config";
import type {
  ContentRepository,
  DeploymentProvider,
  DeploymentStatusRepository,
  FinalApprovedEventConsumerRepository,
  FinalApprovedEventSource,
  PublicationJobRepository,
  PublicationNotificationAdapter,
  PublicationRepository,
  PublicationVerificationRepository,
  PublicPageVerifier,
} from "./interfaces";
import {
  consumptionRecordSchema,
  type PublicationJob,
  publicationJobSchema,
  publicationRecordSchema,
  publicationVerificationSchema,
} from "./models";
import {
  articlePath,
  digest,
  transformForPublication,
  validatePublicArtifact,
} from "./transform";

export interface PublicationDependencies {
  events: FinalApprovedEventSource;
  jobs: PublicationJobRepository;
  publications: PublicationRepository;
  consumption: FinalApprovedEventConsumerRepository;
  deployments: DeploymentStatusRepository;
  verifications: PublicationVerificationRepository;
  drafts: ArticleDraftRepository;
  quality: DraftQualityRepository;
  packets: ResearchPacketRepository;
  reviews: EditorialReviewRepository;
  approvals: FinalApprovalRepository;
  gates: ReviewGateRepository;
  repository: ContentRepository;
  deployment: DeploymentProvider;
  publicPage?: PublicPageVerifier;
  notifications?: PublicationNotificationAdapter;
  config: PublicationConfig;
  tasks: WorkflowArtifactRepository;
  clock?: () => Date;
}
export class PublicationService {
  constructor(private d: PublicationDependencies) {}
  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }
  async next(workerId = "publication-worker", dryRun = false) {
    const event = await this.d.events.next(this.now().toISOString());
    if (!event) return undefined;
    return this.publish(event, workerId, dryRun);
  }
  async event(
    eventId: string,
    workerId = "publication-worker",
    dryRun = false,
  ) {
    const event = await this.d.events.getById(eventId);
    if (!event) throw new Error("Final-approved event not found");
    return this.publish(event, workerId, dryRun);
  }
  async due(workerId = "publication-worker", dryRun = false) {
    const events = await this.d.events.due(this.now().toISOString());
    const out = [];
    for (const event of events)
      out.push(await this.publish(event, workerId, dryRun));
    return out;
  }
  async status(eventId: string) {
    return {
      job: await this.d.jobs.get(eventId),
      publication: await this.d.publications.getByEvent(eventId),
      consumption: await this.d.consumption.get(eventId),
    };
  }
  async retryDeployment(topicId: string, workerId = "publication-retry") {
    const record = await this.d.publications.getByTopic(topicId);
    if (!record || record.status !== "deployment_failed")
      throw new Error("Publication is not eligible for deployment retry");
    return this.event(record.finalApprovedEventId, workerId, false);
  }
  private async publish(
    event: ArticleFinalApprovedEvent,
    workerId: string,
    dryRun: boolean,
  ) {
    const consumed = await this.d.consumption.get(event.id);
    const existing = await this.d.publications.getByEvent(event.id);
    if (consumed && existing)
      return { publication: existing, reused: true, dryRun: false };
    const now = this.now().toISOString();
    this.assertEventTime(event, now);
    if (dryRun) {
      const input = await this.eligible(event);
      const snapshot = transformForPublication({
        draft: input.draft,
        sources: input.packet.sourceIndex.filter((x) =>
          event.sourceIds.includes(x.id),
        ),
        config: this.d.config,
        publishedAt: now,
      });
      validatePublicArtifact(snapshot.mdx);
      const path = articlePath(this.d.config, input.draft.slug, now);
      const current = await this.d.repository.getFile(path);
      const caseCollision = current
        ? null
        : await this.d.repository.findCaseInsensitiveFile(path);
      if (caseCollision)
        throw new Error("Case-insensitive article path collision");
      if (current && current.content !== snapshot.mdx)
        throw new Error("Slug or path collision");
      return {
        publicationId: `publication_${sha256(event.id).slice(0, 24)}`,
        path,
        canonicalUrl: snapshot.canonicalUrl,
        contentHash: snapshot.contentHash,
        sourceCount: snapshot.sources.length,
        reused: false,
        dryRun: true,
      };
    }
    const priorJob = await this.d.jobs.get(event.id);
    if (
      priorJob &&
      priorJob.attempt >= this.d.config.maximumAttempts &&
      ["failed", "blocked"].includes(priorJob.status)
    )
      throw new Error("Maximum publication attempts reached");
    const claimed = await this.d.jobs.claim(
      event,
      workerId,
      now,
      this.d.config.claimTimeoutMinutes * 60000,
    );
    if (!claimed) throw new Error("Publication event is already claimed");
    let job: PublicationJob = claimed;
    const set = async (
      status: PublicationJob["status"],
      extra: Partial<PublicationJob> = {},
    ) => {
      job = publicationJobSchema.parse({
        ...job,
        ...extra,
        status,
        heartbeatAt: this.now().toISOString(),
        version: job.version + 1,
      });
      await this.d.jobs.save(job);
    };
    try {
      await set("validating");
      const input = await this.eligible(event);
      const publicationId = `publication_${sha256(event.id).slice(0, 24)}`;
      await this.d.notifications?.started({
        title: input.draft.title,
        draftVersion: event.draftVersion,
        publicationId,
        scheduled: event.status === "scheduled",
      });
      await set("rendering");
      const snapshot = transformForPublication({
        draft: input.draft,
        sources: input.packet.sourceIndex.filter((x) =>
          event.sourceIds.includes(x.id),
        ),
        config: this.d.config,
        publishedAt: now,
      });
      validatePublicArtifact(snapshot.mdx);
      const path = articlePath(this.d.config, input.draft.slug, now);
      const current = await this.d.repository.getFile(path);
      const caseCollision = current
        ? null
        : await this.d.repository.findCaseInsensitiveFile(path);
      if (caseCollision)
        throw new Error("Case-insensitive article path collision");
      if (current && current.content !== snapshot.mdx)
        throw new Error("Slug or path collision");
      await set("writing_repository");
      await this.assertSnapshot(
        event,
        input.draft,
        input.review.id,
        input.review.version,
        input.review.decision,
      );
      let commit = current
        ? await this.d.repository.getCommit(
            await this.d.repository.getDefaultBranch(),
          )
        : this.d.config.mode === "fixture"
          ? await this.d.repository.getCommit(event.id)
          : null;
      const branch =
        this.d.config.branchStrategy === "direct"
          ? await this.d.repository.getDefaultBranch()
          : `publish/${input.draft.slug}-${event.id.slice(-8)}`;
      if (!commit) {
        const base =
          (
            await this.d.repository.getCommit(
              await this.d.repository.getDefaultBranch(),
            )
          )?.sha ?? "0".repeat(64);
        if (this.d.config.branchStrategy === "publication_branch")
          await this.d.repository.createBranch(branch, base);
        commit = await this.d.repository.createCommit({
          branch,
          expectedParentSha: base,
          message: this.d.config.commitMessagePattern.replace(
            "{title}",
            input.draft.title,
          ),
          files: [{ path, content: snapshot.mdx }],
          idempotencyKey: event.id,
        });
      }
      const written = await this.d.repository.getFile(path, commit.sha);
      if (!written || digest(written.content) !== snapshot.contentHash)
        throw new Error("Committed article verification failed");
      let record = publicationRecordSchema.parse({
        id: publicationId,
        topicId: event.topicId,
        draftId: event.draftId,
        draftVersion: event.draftVersion,
        reviewId: event.reviewId,
        reviewVersion: event.reviewVersion,
        researchPacketId: event.researchPacketId,
        researchPacketVersion: event.researchPacketVersion,
        finalApprovedEventId: event.id,
        status: "committed",
        title: input.draft.title,
        slug: input.draft.slug,
        articlePath: path,
        repository: this.d.config.repository,
        branch,
        commitSha: commit.sha,
        commitUrl: commit.url,
        deploymentProvider: this.d.config.deploymentProvider,
        canonicalUrl: snapshot.canonicalUrl,
        publishedAt: now,
        scheduledFor: event.requestedPublishAt,
        sourceCount: snapshot.sources.length,
        contentHash: snapshot.contentHash,
        approvedSnapshotHash: event.articleSnapshotHash,
        publishedSnapshotHash: digest(JSON.stringify(snapshot)),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        warnings: [],
        provenance: { mode: this.d.config.mode, parentSha: commit.parentSha },
        version: (existing?.version ?? 0) + 1,
      });
      await this.d.publications.save(record);
      await this.d.notifications?.committed({
        publicationId,
        commitSha: commit.sha,
        articlePath: path,
        deploymentStatus: "pending",
      });
      await set("waiting_for_deployment", { publicationId });
      const deployment = await this.d.deployment.waitForDeployment({
        publicationId,
        commitSha: commit.sha,
        canonicalUrl: snapshot.canonicalUrl,
        timeoutMs: this.d.config.deploymentTimeoutSeconds * 1000,
        pollIntervalMs: this.d.config.pollIntervalSeconds * 1000,
      });
      await this.d.deployments.save(deployment);
      let verified = deployment.status === "ready";
      if (
        verified &&
        this.d.config.publicPageVerification &&
        this.d.publicPage
      ) {
        await set("verifying_deployment");
        const check = await this.d.publicPage.verify({
          publicationId,
          url: snapshot.canonicalUrl,
          title: snapshot.title,
          fingerprint: snapshot.contentHash.slice(0, 16),
        });
        await this.d.verifications.save(check);
        verified = check.status === "verified";
      }
      if (
        this.d.config.deploymentPolicy === "manual" ||
        deployment.status === "verification_required"
      ) {
        await this.writeVerificationTask(record);
        record = publicationRecordSchema.parse({
          ...record,
          status: "verification_required",
          deploymentId: deployment.deploymentId,
          deploymentUrl: deployment.url,
          updatedAt: this.now().toISOString(),
          version: record.version + 1,
        });
        await this.d.publications.save(record);
        await set("blocked");
        return { publication: record, reused: false, dryRun: false };
      }
      if (!verified && this.d.config.deploymentPolicy === "required") {
        record = publicationRecordSchema.parse({
          ...record,
          status: "deployment_failed",
          updatedAt: this.now().toISOString(),
          version: record.version + 1,
        });
        await this.d.publications.save(record);
        await set("failed", {
          failedAt: this.now().toISOString(),
          failureCode: "deployment_verification_failed",
          failureMessage: "Required production deployment was not verified",
        });
        await this.d.notifications?.failed({
          publicationId,
          category: "deployment_verification_failed",
          retryable: true,
        });
        return { publication: record, reused: false, dryRun: false };
      }
      record = publicationRecordSchema.parse({
        ...record,
        status: verified ? "published" : "deployment_failed",
        deploymentId: deployment.deploymentId,
        deploymentUrl: deployment.url,
        updatedAt: this.now().toISOString(),
        warnings: verified
          ? []
          : ["Deployment not verified; best-effort policy consumed the event"],
        version: record.version + 1,
      });
      await this.assertSnapshot(
        event,
        input.draft,
        input.review.id,
        input.review.version,
        input.review.decision,
      );
      await this.d.publications.save(record);
      const consumption = consumptionRecordSchema.parse({
        finalApprovedEventId: event.id,
        consumerId: workerId,
        publicationId,
        commitSha: commit.sha,
        deploymentId: deployment.deploymentId,
        verificationState: verified ? "verified" : "best_effort",
        consumedAt: this.now().toISOString(),
        snapshotHash: event.articleSnapshotHash,
      });
      await this.assertSnapshot(
        event,
        input.draft,
        input.review.id,
        input.review.version,
        input.review.decision,
      );
      if (
        !(await this.d.consumption.consume(consumption)) &&
        !(await this.d.consumption.get(event.id))
      )
        throw new Error("Event consumption conflict");
      await set("completed", {
        completedAt: this.now().toISOString(),
        publicationId,
      });
      await this.d.notifications?.published({
        canonicalUrl: record.canonicalUrl,
        publishedAt: record.publishedAt,
        commitSha: record.commitSha,
        deploymentStatus: record.status,
      });
      return { publication: record, reused: false, dryRun: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Publication failed";
      await set("failed", {
        failedAt: this.now().toISOString(),
        failureCode: "publication_failed",
        failureMessage: message.slice(0, 1000),
      });
      throw e;
    }
  }
  private assertEventTime(event: ArticleFinalApprovedEvent, now: string) {
    if (!["ready_for_publication", "scheduled"].includes(event.status))
      throw new Error(`Event status ${event.status} is not publishable`);
    if (event.status === "scheduled") {
      if (!event.requestedPublishAt)
        throw new Error("Scheduled event has no normalized UTC time");
      if (Date.parse(event.requestedPublishAt) > Date.parse(now))
        throw new Error("Scheduled publication is not due");
      if (
        Date.parse(now) - Date.parse(event.requestedPublishAt) >
        this.d.config.scheduledGraceMinutes * 60000
      )
        throw new Error("Scheduled publication grace window expired");
    }
  }
  private async eligible(event: ArticleFinalApprovedEvent) {
    const [draft, latest, quality, packet, review, approval] =
      await Promise.all([
        this.d.drafts.get(event.topicId, event.draftVersion),
        this.d.drafts.get(event.topicId),
        this.d.quality.get(event.topicId, event.draftVersion),
        this.d.packets.get(event.topicId, event.researchPacketVersion),
        this.d.reviews.get(
          event.topicId,
          event.draftVersion,
          event.reviewVersion,
        ),
        this.d.approvals.get(event.topicId),
      ]);
    if (!draft || !quality || !packet || !review || !approval)
      throw new Error("Exact approved publication inputs are missing");
    if (latest?.version !== event.draftVersion)
      throw new Error("A newer draft invalidates final approval");
    if (
      draft.id !== event.draftId ||
      review.id !== event.reviewId ||
      packet.id !== event.researchPacketId
    )
      throw new Error("Final-approved event does not bind to exact inputs");
    if (
      !["pass", "pass_with_warnings"].includes(review.decision) ||
      review.issues.some(
        (x) =>
          !["resolved", "waived"].includes(x.status) &&
          (x.blocking || x.severity === "critical"),
      )
    )
      throw new Error("Editorial review is not publication eligible");
    if (
      quality.status === "blocked" ||
      packet.status !== "ready" ||
      !packet.sufficient
    )
      throw new Error("Draft quality or research packet is not ready");
    if (
      !["approved", "scheduled"].includes(approval.status) ||
      approval.draftVersion !== event.draftVersion ||
      approval.reviewVersion !== event.reviewVersion
    )
      throw new Error("Final Telegram article approval is no longer valid");
    if (!(await this.d.gates.topicActive(event.topicId, draft.approvedEventId)))
      throw new Error("Telegram topic approval is no longer active");
    const inspection = inspectMdx(draft.mdx, new Set(event.sourceIds));
    if (
      inspection.safetyIssues.length ||
      inspection.unknownCitationSourceIds.length
    )
      throw new Error("Approved MDX safety or citations failed");
    await this.assertSnapshot(
      event,
      draft,
      review.id,
      review.version,
      review.decision,
    );
    return { draft, packet, review };
  }
  private async assertSnapshot(
    event: ArticleFinalApprovedEvent,
    draft: NonNullable<Awaited<ReturnType<ArticleDraftRepository["get"]>>>,
    reviewId: string,
    reviewVersion: number,
    decision: string,
  ) {
    const hash = sha256(
      JSON.stringify({ draft, reviewId, reviewVersion, decision }),
    );
    if (hash !== event.articleSnapshotHash)
      throw new Error("Approved article snapshot hash mismatch");
  }
  private async writeVerificationTask(
    record: Awaited<ReturnType<typeof publicationRecordSchema.parse>>,
  ) {
    const files: Record<string, string | object> = {
      "verify-publication.md": `# Verify publication\n\nCheck ${record.canonicalUrl}: title, content, canonical, formatting, sources, draft badge, and mobile readability.\n`,
      "publication-summary.json": {
        publicationId: record.id,
        title: record.title,
        canonicalUrl: record.canonicalUrl,
        commitSha: record.commitSha,
      },
      "expected-verification.schema.json": {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: [
          "publicationId",
          "status",
          "urlLoads",
          "correctTitle",
          "correctContent",
          "correctCanonicalUrl",
          "formattingOk",
          "sourcesRender",
          "noDraftBadge",
          "mobileReadable",
          "verifiedAt",
          "verifier",
          "notes",
        ],
      },
    };
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        this.d.tasks.save({
          runId: record.id,
          stage: "publication",
          name,
          mediaType: name.endsWith(".json")
            ? "application/json"
            : "text/markdown",
          content,
        }),
      ),
    );
    return this.d.tasks.location(record.id, "publication");
  }
  async importVerification(publicationId: string, value: unknown) {
    const record = (await this.d.publications.list()).find(
      (x) => x.id === publicationId,
    );
    if (!record) throw new Error("Publication not found");
    const hash = digest(JSON.stringify(value));
    const old = await this.d.verifications.get(publicationId);
    if (old?.importHash === hash) return old;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Verification import must be an object");
    const parsed = publicationVerificationSchema.parse({
      ...value,
      publicationId,
      verifier: "manual",
      importHash: hash,
    });
    await this.d.verifications.save(parsed);
    if (parsed.status === "verified") {
      const [event, draft, review] = await Promise.all([
        this.d.events.getById(record.finalApprovedEventId),
        this.d.drafts.get(record.topicId, record.draftVersion),
        this.d.reviews.get(
          record.topicId,
          record.draftVersion,
          record.reviewVersion,
        ),
      ]);
      if (!event || !draft || !review)
        throw new Error("Approved inputs are unavailable for verification");
      await this.assertSnapshot(
        event,
        draft,
        review.id,
        review.version,
        review.decision,
      );
      await this.d.consumption.consume(
        consumptionRecordSchema.parse({
          finalApprovedEventId: record.finalApprovedEventId,
          consumerId: "manual-verification",
          publicationId,
          commitSha: record.commitSha,
          deploymentId: record.deploymentId,
          verificationState: "verified",
          consumedAt: this.now().toISOString(),
          snapshotHash: record.approvedSnapshotHash,
        }),
      );
      await this.d.publications.save(
        publicationRecordSchema.parse({
          ...record,
          status: "published",
          updatedAt: this.now().toISOString(),
          version: record.version + 1,
        }),
      );
    }
    return parsed;
  }
}
