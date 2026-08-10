import { sha256 } from "../writing/task";
import type { PublicationConfig } from "./config";
import type {
  ContentRepository,
  DeploymentProvider,
  ProductionPublicationArtifactRepository,
  PublicationRepublishRepository,
  PublicationRepository,
} from "./interfaces";
import { legacyProductionPublicationArtifactSchema } from "./models";
import { canonicalUrl, digest } from "./transform";

const visualScope = [
  "production_rendering",
  "writing_listing",
  "formatting",
  "references",
  "mobile_layout",
] as const;

export interface RepublishVerificationRequest {
  republishId: string;
  dryRun: boolean;
  manualVerificationAcknowledged: boolean;
}

export class PublicationRepublishVerificationService {
  constructor(
    private d: {
      publications: PublicationRepository;
      republishes: PublicationRepublishRepository;
      productionArtifacts: ProductionPublicationArtifactRepository;
      repository: ContentRepository;
      deployment: DeploymentProvider;
      config: PublicationConfig;
      clock?: () => Date;
    },
  ) {}

  async verify(request: RepublishVerificationRequest) {
    const existing = await this.d.productionArtifacts.getByRepublishId(
      request.republishId,
    );
    if (existing && "republishId" in existing && !request.dryRun)
      return { artifact: existing, reused: true, dryRun: false };

    this.assertProductionConfiguration();
    const republish = await this.d.republishes.getById(request.republishId);
    if (!republish) throw new Error("Republish record not found");
    const source = (await this.d.publications.list()).find(
      (value) => value.id === republish.sourcePublicationId,
    );
    if (!source) throw new Error("Source fixture publication not found");
    this.assertLineage(source, republish);

    const defaultBranch = await this.d.repository.getDefaultBranch();
    if (
      defaultBranch !== republish.baseBranch ||
      defaultBranch !== this.d.config.defaultBranch
    )
      throw new Error(
        "Production default branch does not match republish lineage",
      );
    const [republishCommit, productionCommit] = await Promise.all([
      this.d.repository.getCommit(republish.commitSha),
      this.d.repository.getCommit(defaultBranch),
    ]);
    if (!republishCommit || republishCommit.sha !== republish.commitSha)
      throw new Error("Republish commit does not exist at the recorded SHA");
    if (!productionCommit)
      throw new Error("Production branch HEAD could not be resolved");
    if (
      !(await this.d.repository.isAncestor(
        republish.commitSha,
        productionCommit.sha,
      ))
    )
      throw new Error("Republish commit is not an ancestor of production HEAD");

    const file = await this.d.repository.getFile(
      republish.articlePath,
      productionCommit.sha,
    );
    if (!file) throw new Error("Article path is missing at production HEAD");
    const contentHash = digest(file.content);
    if (contentHash !== republish.targetContentHash)
      throw new Error("Production article content hash mismatch");
    assertCanonicalFrontmatter(file.content, republish.canonicalUrl);

    const artifactId = `publication_${sha256(`production:${republish.id}`).slice(0, 24)}`;
    const deployment = await this.d.deployment.getDeploymentStatus({
      publicationId: artifactId,
      commitSha: productionCommit.sha,
    });
    if (
      deployment.provider !== "vercel_git" ||
      deployment.status !== "ready" ||
      deployment.environment !== "production"
    )
      throw new Error("Production deployment is not ready");
    if (!request.manualVerificationAcknowledged)
      throw new Error(
        "Protected production rendering requires --manual-verification-acknowledged",
      );

    const verifiedAt = (this.d.clock ?? (() => new Date()))().toISOString();
    const idempotencyKey = sha256(
      JSON.stringify({
        republishId: republish.id,
        productionCommitSha: productionCommit.sha,
        articlePath: republish.articlePath,
        canonicalUrl: republish.canonicalUrl,
        targetContentHash: republish.targetContentHash,
        deploymentProvider: deployment.provider,
        deploymentId: deployment.deploymentId,
      }),
    );
    const artifact = legacyProductionPublicationArtifactSchema.parse({
      id: artifactId,
      sourcePublicationId: source.id,
      republishId: republish.id,
      topicId: source.topicId,
      draftId: source.draftId,
      draftVersion: source.draftVersion,
      reviewId: source.reviewId,
      reviewVersion: source.reviewVersion,
      researchPacketId: source.researchPacketId,
      researchPacketVersion: source.researchPacketVersion,
      finalApprovedEventId: source.finalApprovedEventId,
      status: "published",
      title: source.title,
      slug: source.slug,
      articlePath: republish.articlePath,
      repository: republish.repository,
      branch: defaultBranch,
      baseBranch: republish.baseBranch,
      republishBranch: republish.branch,
      republishCommitSha: republish.commitSha,
      productionCommitSha: productionCommit.sha,
      republishCommitIsAncestor: true,
      commitSha: productionCommit.sha,
      commitUrl: productionCommit.url,
      deploymentProvider: deployment.provider,
      deploymentStatus: "ready",
      deploymentEnvironment: "production",
      deploymentId: deployment.deploymentId,
      deploymentUrl: deployment.url,
      canonicalUrl: republish.canonicalUrl,
      publishedAt: deployment.checkedAt,
      sourceCount: source.sourceCount,
      contentHash,
      expectedContentHash: republish.targetContentHash,
      approvedSnapshotHash: republish.approvedSnapshotHash,
      publishedSnapshotHash: republish.sourcePublishedSnapshotHash,
      createdAt: verifiedAt,
      updatedAt: verifiedAt,
      verifiedAt,
      verificationMethods: [
        "repository_commit",
        "commit_ancestry",
        "production_blob_hash",
        "canonical_frontmatter",
        "production_deployment",
        "operator_visual_acknowledgement",
      ],
      operatorAcknowledgement: {
        acknowledged: true,
        acknowledgedAt: verifiedAt,
        scope: visualScope,
      },
      idempotencyKey,
      warnings: [
        "Anonymous page verification was not required because protected rendering was manually verified.",
      ],
      provenance: {
        mode: "github_republish_verified",
        sourceMode: "fixture",
        sourcePublicationId: source.id,
        republishId: republish.id,
        sourceFinalApprovedEventId: source.finalApprovedEventId,
        sourceApprovedSnapshotHash: source.approvedSnapshotHash,
        sourcePublishedSnapshotHash: source.publishedSnapshotHash,
        version: 1,
      },
      version: 1,
    });
    if (!request.dryRun) await this.d.productionArtifacts.save(artifact);
    return { artifact, reused: false, dryRun: request.dryRun };
  }

  async status(republishId: string) {
    const republish = await this.d.republishes.getById(republishId);
    if (!republish) throw new Error("Republish record not found");
    const artifact =
      await this.d.productionArtifacts.getByRepublishId(republishId);
    const source = (await this.d.publications.list()).find(
      (value) => value.id === republish.sourcePublicationId,
    );
    return {
      sourcePublication: source
        ? { id: source.id, mode: source.provenance.mode }
        : undefined,
      republish: {
        id: republish.id,
        repository: republish.repository,
        commitSha: republish.commitSha,
        status: artifact ? "verified" : republish.status,
      },
      production: artifact,
      downstreamEligibility: {
        social: Boolean(artifact),
        analytics: Boolean(artifact),
      },
    };
  }

  private assertProductionConfiguration() {
    if (
      this.d.config.mode !== "github" ||
      this.d.config.deploymentProvider !== "vercel_git"
    )
      throw new Error(
        "Republish verification requires GitHub and Vercel production mode",
      );
  }

  private assertLineage(
    source: Awaited<ReturnType<PublicationRepository["list"]>>[number],
    republish: NonNullable<
      Awaited<ReturnType<PublicationRepublishRepository["getById"]>>
    >,
  ) {
    if (
      source.provenance.mode !== "fixture" ||
      source.deploymentProvider !== "mock" ||
      republish.provenance.sourcePublicationId !== source.id ||
      republish.sourceFinalApprovedEventId !== source.finalApprovedEventId ||
      republish.repository !== this.d.config.repository ||
      republish.canonicalUrl !== canonicalUrl(this.d.config, source.slug) ||
      republish.sourceContentHash !== source.contentHash ||
      republish.approvedSnapshotHash !== source.approvedSnapshotHash ||
      republish.sourcePublishedSnapshotHash !== source.publishedSnapshotHash
    )
      throw new Error("Republish source lineage or configured target mismatch");
  }
}

export function assertCanonicalFrontmatter(content: string, expected: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    content,
  )?.[1];
  if (!frontmatter)
    throw new Error("Production article frontmatter is missing");
  const values = [
    ...frontmatter.matchAll(
      /^canonicalUrl:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/gm,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  if (values.length !== 1 || values[0] !== expected)
    throw new Error("Production canonical URL mismatch");
}
