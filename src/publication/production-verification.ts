import { sha256 } from "../writing/task";
import type { DatabaseClient } from "../database/client";
import { toJsonValue } from "../database/json";
import type { PublicationConfig } from "./config";
import type {
  ContentRepository,
  DeploymentProvider,
  PublicationRepository,
} from "./interfaces";
import {
  directProductionPublicationArtifactSchema,
  type DirectProductionPublicationArtifact,
} from "./models";
import { assertCanonicalFrontmatter } from "./republish-verification";
import { digest } from "./transform";

export class DirectProductionVerificationService {
  constructor(
    private readonly deps: {
      publications: PublicationRepository;
      artifacts: DirectProductionArtifactRepository;
      repository: ContentRepository;
      deployment: DeploymentProvider;
      config: PublicationConfig;
      clock?: () => Date;
    },
  ) {}

  async verify(publicationId: string) {
    const existing = await this.deps.artifacts.getById(publicationId);
    if (existing) return { artifact: existing, reused: true };
    const publication = (await this.deps.publications.list()).find(
      (value) => value.id === publicationId,
    );
    if (
      !publication ||
      publication.status !== "published" ||
      publication.provenance.mode !== "github"
    )
      throw new Error("A verified GitHub publication record is required");
    if (
      this.deps.config.mode !== "github" ||
      this.deps.config.branchStrategy !== "direct" ||
      this.deps.config.deploymentProvider !== "vercel_git" ||
      this.deps.config.deploymentPolicy !== "required"
    )
      throw new Error(
        "Direct production verification is not configured safely",
      );
    const branch = await this.deps.repository.getDefaultBranch();
    const [publicationCommit, productionCommit] = await Promise.all([
      this.deps.repository.getCommit(publication.commitSha),
      this.deps.repository.getCommit(branch),
    ]);
    if (!publicationCommit || !productionCommit)
      throw new Error("Publication or production commit could not be resolved");
    if (
      !(await this.deps.repository.isAncestor(
        publication.commitSha,
        productionCommit.sha,
      ))
    )
      throw new Error(
        "Publication commit is not an ancestor of production main",
      );
    const file = await this.deps.repository.getFile(
      publication.articlePath,
      productionCommit.sha,
    );
    if (!file || digest(file.content) !== publication.contentHash)
      throw new Error("Production article content hash mismatch");
    assertCanonicalFrontmatter(file.content, publication.canonicalUrl);
    const deployment = await this.deps.deployment.getDeploymentStatus({
      publicationId,
      commitSha: productionCommit.sha,
    });
    if (
      deployment.status !== "ready" ||
      deployment.environment !== "production"
    )
      throw new Error(
        "Vercel production deployment is not ready for production main",
      );
    const verifiedAt = (this.deps.clock ?? (() => new Date()))().toISOString();
    const artifact = directProductionPublicationArtifactSchema.parse({
      ...publication,
      sourcePublicationId: publication.id,
      baseBranch: branch,
      productionCommitSha: productionCommit.sha,
      commitSha: productionCommit.sha,
      commitUrl: productionCommit.url,
      deploymentId: deployment.deploymentId,
      deploymentUrl: deployment.url,
      deploymentStatus: "ready",
      deploymentEnvironment: "production",
      expectedContentHash: publication.contentHash,
      verifiedAt,
      updatedAt: verifiedAt,
      verificationMethods: [
        "repository_commit",
        "commit_ancestry",
        "production_blob_hash",
        "canonical_frontmatter",
        "production_deployment",
      ],
      idempotencyKey: sha256(
        JSON.stringify({
          publicationId: publication.id,
          eventId: publication.finalApprovedEventId,
          productionCommitSha: productionCommit.sha,
          articlePath: publication.articlePath,
          contentHash: publication.contentHash,
          deploymentId: deployment.deploymentId,
        }),
      ),
      provenance: {
        mode: "github_direct_verified",
        sourcePublicationId: publication.id,
        sourceFinalApprovedEventId: publication.finalApprovedEventId,
        sourceApprovedSnapshotHash: publication.approvedSnapshotHash,
        sourcePublishedSnapshotHash: publication.publishedSnapshotHash,
        version: 1,
      },
    });
    await this.deps.artifacts.save(artifact);
    return { artifact, reused: false };
  }
}

export interface DirectProductionArtifactRepository {
  getById(id: string): Promise<DirectProductionPublicationArtifact | undefined>;
  save(value: DirectProductionPublicationArtifact): Promise<void>;
}

export class PostgresDirectProductionArtifactRepository implements DirectProductionArtifactRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async getById(id: string) {
    const rows = await this.sql<{ payload: unknown }[]>`
      select payload from content_machine.production_publication_artifacts
      where id=${id} and republish_id is null
    `;
    return rows[0]
      ? directProductionPublicationArtifactSchema.parse(rows[0].payload)
      : undefined;
  }

  async save(record: DirectProductionPublicationArtifact) {
    const value = directProductionPublicationArtifactSchema.parse(record);
    const rows = await this.sql<{ id: string }[]>`
      insert into content_machine.production_publication_artifacts
        (id,republish_id,source_publication_id,event_id,repository,production_commit_sha,canonical_url,content_hash,deployment_provider,deployment_status,idempotency_key,payload,verified_at)
      values (${value.id},null,${value.sourcePublicationId},${value.finalApprovedEventId},${value.repository},${value.productionCommitSha},${value.canonicalUrl},${value.contentHash},${value.deploymentProvider},${value.deploymentStatus},${value.idempotencyKey},${this.sql.json(toJsonValue(value))},${value.verifiedAt})
      on conflict(id) do nothing returning id
    `;
    if (!rows[0]) {
      const existing = await this.getById(value.id);
      if (JSON.stringify(existing) !== JSON.stringify(value))
        throw new Error("Direct production artifact is immutable");
    }
  }
}
