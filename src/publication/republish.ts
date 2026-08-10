import type { ArticleDraftRepository } from "../writing/interfaces";
import type { EditorialReviewRepository } from "../review/interfaces";
import { sha256 } from "../writing/task";
import type { PublicationConfig } from "./config";
import type {
  ContentRepository,
  FinalApprovedEventConsumerRepository,
  FinalApprovedEventSource,
  PublicationRepublishRepository,
  PublicationRepository,
} from "./interfaces";
import { publicationRepublishRecordSchema } from "./models";
import { articlePath, canonicalUrl, digest } from "./transform";

export interface RepublishDependencies {
  publications: PublicationRepository;
  republishes: PublicationRepublishRepository;
  consumption: FinalApprovedEventConsumerRepository;
  events: FinalApprovedEventSource;
  drafts: ArticleDraftRepository;
  reviews: EditorialReviewRepository;
  sourceRepository: ContentRepository;
  targetRepository: ContentRepository;
  config: PublicationConfig;
  clock?: () => Date;
}

export interface RepublishRequest {
  sourcePublicationId: string;
  expectedRepository: string;
  expectedBaseBranch: string;
  expectedSourceContentHash: string;
  expectedApprovedSnapshotHash: string;
  expectedPublishedSnapshotHash: string;
  dryRun: boolean;
}

export class PublicationRepublishService {
  constructor(private d: RepublishDependencies) {}

  async republish(request: RepublishRequest) {
    this.assertTarget(request);
    const source = (await this.d.publications.list()).find(
      (record) => record.id === request.sourcePublicationId,
    );
    if (!source) throw new Error("Source publication not found");
    if (
      source.status !== "published" ||
      source.provenance.mode !== "fixture" ||
      source.deploymentProvider !== "mock"
    )
      throw new Error("Source must be a successful fixture publication");
    if (source.contentHash !== request.expectedSourceContentHash)
      throw new Error("Source publication content hash mismatch");
    if (source.approvedSnapshotHash !== request.expectedApprovedSnapshotHash)
      throw new Error("Approved snapshot hash mismatch");
    if (source.publishedSnapshotHash !== request.expectedPublishedSnapshotHash)
      throw new Error("Published snapshot hash mismatch");

    const [consumption, event, draft, review, sourceFile] = await Promise.all([
      this.d.consumption.get(source.finalApprovedEventId),
      this.d.events.getById(source.finalApprovedEventId),
      this.d.drafts.get(source.topicId, source.draftVersion),
      this.d.reviews.get(
        source.topicId,
        source.draftVersion,
        source.reviewVersion,
      ),
      this.d.sourceRepository.getFile(source.articlePath, source.commitSha),
    ]);
    if (
      !consumption ||
      consumption.publicationId !== source.id ||
      consumption.snapshotHash !== source.approvedSnapshotHash
    )
      throw new Error("Fixture publication consumption lineage mismatch");
    if (!event || !draft || !review || !sourceFile)
      throw new Error("Exact fixture publication inputs are missing");
    if (
      event.id !== source.finalApprovedEventId ||
      event.draftId !== source.draftId ||
      event.draftVersion !== source.draftVersion ||
      event.reviewId !== source.reviewId ||
      event.reviewVersion !== source.reviewVersion ||
      event.researchPacketId !== source.researchPacketId ||
      event.researchPacketVersion !== source.researchPacketVersion
    )
      throw new Error("Fixture publication input lineage mismatch");
    const approvedSnapshotHash = sha256(
      JSON.stringify({
        draft,
        reviewId: review.id,
        reviewVersion: review.version,
        decision: review.decision,
      }),
    );
    if (
      approvedSnapshotHash !== event.articleSnapshotHash ||
      approvedSnapshotHash !== source.approvedSnapshotHash
    )
      throw new Error("Exact approved article snapshot has changed");
    if (digest(sourceFile.content) !== source.contentHash)
      throw new Error("Fixture artifact content hash mismatch");

    const targetPath = articlePath(
      this.d.config,
      source.slug,
      source.publishedAt,
    );
    const targetCanonicalUrl = canonicalUrl(this.d.config, source.slug);
    const targetContent = canonicalOnlyMigration(
      sourceFile.content,
      source.canonicalUrl,
      targetCanonicalUrl,
    );
    const targetContentHash = digest(targetContent);
    const branch = `republish/${source.slug}-${source.id.slice(-8)}`;
    const idempotencyKey = digest(
      JSON.stringify({
        sourcePublicationId: source.id,
        repository: this.d.config.repository,
        baseBranch: this.d.config.defaultBranch,
        branch,
        articlePath: targetPath,
        sourceContentHash: source.contentHash,
        targetContentHash,
      }),
    );
    const existing =
      await this.d.republishes.getByIdempotencyKey(idempotencyKey);
    if (existing) return { republish: existing, reused: true, dryRun: false };

    const defaultBranch = await this.d.targetRepository.getDefaultBranch();
    if (defaultBranch !== request.expectedBaseBranch)
      throw new Error("Target default branch changed");
    const baseCommit = await this.d.targetRepository.getCommit(defaultBranch);
    if (!baseCommit) throw new Error("Target default branch commit not found");
    const current = await this.d.targetRepository.getFile(
      targetPath,
      defaultBranch,
    );
    const caseCollision = current
      ? null
      : await this.d.targetRepository.findCaseInsensitiveFile(
          targetPath,
          defaultBranch,
        );
    if (caseCollision)
      throw new Error("Case-insensitive article path collision");
    if (current) throw new Error("Target article path already exists");

    const plan = {
      republishId: `republish_${idempotencyKey.slice(0, 24)}`,
      sourcePublicationId: source.id,
      sourceFinalApprovedEventId: source.finalApprovedEventId,
      repository: this.d.config.repository,
      baseBranch: defaultBranch,
      branch,
      articlePath: targetPath,
      canonicalUrl: targetCanonicalUrl,
      sourceContentHash: source.contentHash,
      targetContentHash,
      approvedSnapshotHash,
      sourcePublishedSnapshotHash: source.publishedSnapshotHash,
      idempotencyKey,
    };
    if (request.dryRun) return { ...plan, reused: false, dryRun: true };

    let commit = await this.d.targetRepository.getCommit(branch);
    if (commit) {
      const recovered = await this.d.targetRepository.getFile(
        targetPath,
        branch,
      );
      if (!recovered || digest(recovered.content) !== targetContentHash)
        throw new Error("Republish branch conflict");
    } else {
      commit = await this.d.targetRepository.createCommitOnNewBranch({
        branch,
        expectedParentSha: baseCommit.sha,
        message: `republish: migrate ${source.title}`,
        files: [{ path: targetPath, content: targetContent }],
        idempotencyKey,
      });
    }
    const written = await this.d.targetRepository.getFile(
      targetPath,
      commit.sha,
    );
    if (!written || digest(written.content) !== targetContentHash)
      throw new Error("Republished article verification failed");

    const record = publicationRepublishRecordSchema.parse({
      id: plan.republishId,
      sourcePublicationId: source.id,
      sourceFinalApprovedEventId: source.finalApprovedEventId,
      status: "verification_required",
      repository: plan.repository,
      baseBranch: plan.baseBranch,
      branch: plan.branch,
      articlePath: plan.articlePath,
      commitSha: commit.sha,
      commitUrl: commit.url,
      canonicalUrl: plan.canonicalUrl,
      sourceCanonicalUrl: source.canonicalUrl,
      sourceContentHash: plan.sourceContentHash,
      targetContentHash: plan.targetContentHash,
      approvedSnapshotHash: plan.approvedSnapshotHash,
      sourcePublishedSnapshotHash: plan.sourcePublishedSnapshotHash,
      idempotencyKey,
      createdAt: (this.d.clock ?? (() => new Date()))().toISOString(),
      provenance: {
        mode: "github_republish",
        sourceMode: "fixture",
        sourcePublicationId: source.id,
        transformation: "canonical_url_only",
        parentSha: commit.parentSha,
      },
      version: 1,
    });
    await this.d.republishes.save(record);
    return { republish: record, reused: false, dryRun: false };
  }

  private assertTarget(request: RepublishRequest) {
    if (this.d.config.mode !== "github")
      throw new Error("Republish requires GitHub publication mode");
    if (this.d.config.branchStrategy !== "publication_branch")
      throw new Error("Republish requires publication_branch strategy");
    if (this.d.config.repository !== request.expectedRepository)
      throw new Error("Target repository does not match explicit expectation");
    if (this.d.config.defaultBranch !== request.expectedBaseBranch)
      throw new Error("Target base branch does not match explicit expectation");
  }
}

export function canonicalOnlyMigration(
  source: string,
  sourceCanonicalUrl: string,
  targetCanonicalUrl: string,
) {
  const marker = `canonicalUrl: ${JSON.stringify(sourceCanonicalUrl)}`;
  const replacement = `canonicalUrl: ${JSON.stringify(targetCanonicalUrl)}`;
  if (source.split(marker).length !== 2)
    throw new Error("Fixture canonical URL is missing or ambiguous");
  const target = source.replace(marker, replacement);
  if (target.replace(replacement, marker) !== source)
    throw new Error("Republish altered content beyond the canonical URL");
  return target;
}
