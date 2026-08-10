import type { ArticleFinalApprovedEvent } from "../review/models";
import type {
  PublicationJob,
  PublicationRecord,
  ConsumptionRecord,
  DeploymentRecord,
  PublicationVerification,
  PublicationRepublishRecord,
  ProductionPublicationArtifact,
} from "./models";

export interface RepositoryFile {
  path: string;
  content: string;
  sha: string;
}
export interface RepositoryCommit {
  sha: string;
  parentSha: string;
  branch: string;
  url?: string;
}
export interface ContentRepository {
  getDefaultBranch(): Promise<string>;
  getFile(path: string, ref?: string): Promise<RepositoryFile | null>;
  findCaseInsensitiveFile(
    path: string,
    ref?: string,
  ): Promise<RepositoryFile | null>;
  createBranch(name: string, baseSha: string): Promise<void>;
  createCommit(input: {
    branch: string;
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
    idempotencyKey: string;
  }): Promise<RepositoryCommit>;
  createCommitOnNewBranch(input: {
    branch: string;
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
    idempotencyKey: string;
  }): Promise<RepositoryCommit>;
  updateRef(
    branch: string,
    commitSha: string,
    expectedSha: string,
  ): Promise<void>;
  getCommit(shaOrIdempotencyKey: string): Promise<RepositoryCommit | null>;
  isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean>;
}
export interface DeploymentProvider {
  waitForDeployment(input: {
    publicationId: string;
    commitSha: string;
    canonicalUrl: string;
    timeoutMs: number;
    pollIntervalMs: number;
  }): Promise<DeploymentRecord>;
  getDeploymentStatus(input: {
    publicationId: string;
    commitSha: string;
  }): Promise<DeploymentRecord>;
}
export interface PublicPageVerifier {
  verify(input: {
    publicationId: string;
    url: string;
    title: string;
    fingerprint: string;
  }): Promise<PublicationVerification>;
}
export interface PublicationJobRepository {
  claim(
    event: ArticleFinalApprovedEvent,
    workerId: string,
    now: string,
    staleAfterMs: number,
  ): Promise<PublicationJob | undefined>;
  get(eventId: string): Promise<PublicationJob | undefined>;
  save(job: PublicationJob): Promise<void>;
}
export interface PublicationRepository {
  getByEvent(eventId: string): Promise<PublicationRecord | undefined>;
  getByTopic(topicId: string): Promise<PublicationRecord | undefined>;
  save(record: PublicationRecord): Promise<void>;
  list(): Promise<PublicationRecord[]>;
}
export interface PublicationRepublishRepository {
  getById(id: string): Promise<PublicationRepublishRecord | undefined>;
  getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PublicationRepublishRecord | undefined>;
  save(record: PublicationRepublishRecord): Promise<void>;
  list(): Promise<PublicationRepublishRecord[]>;
}
export interface ProductionPublicationArtifactRepository {
  getById(id: string): Promise<ProductionPublicationArtifact | undefined>;
  getByRepublishId(
    republishId: string,
  ): Promise<ProductionPublicationArtifact | undefined>;
  save(record: ProductionPublicationArtifact): Promise<void>;
  list(): Promise<ProductionPublicationArtifact[]>;
}
export interface FinalApprovedEventConsumerRepository {
  get(eventId: string): Promise<ConsumptionRecord | undefined>;
  consume(record: ConsumptionRecord): Promise<boolean>;
}
export interface DeploymentStatusRepository {
  get(publicationId: string): Promise<DeploymentRecord | undefined>;
  save(record: DeploymentRecord): Promise<void>;
}
export interface PublicationVerificationRepository {
  get(publicationId: string): Promise<PublicationVerification | undefined>;
  save(record: PublicationVerification): Promise<void>;
}
export interface FinalApprovedEventSource {
  getById(eventId: string): Promise<ArticleFinalApprovedEvent | undefined>;
  next(now: string): Promise<ArticleFinalApprovedEvent | undefined>;
  due(now: string): Promise<ArticleFinalApprovedEvent[]>;
}
export interface PublicationNotificationAdapter {
  started(input: {
    title: string;
    draftVersion: number;
    publicationId: string;
    scheduled: boolean;
  }): Promise<void>;
  committed(input: {
    publicationId: string;
    commitSha: string;
    articlePath: string;
    deploymentStatus: string;
  }): Promise<void>;
  published(input: {
    canonicalUrl: string;
    publishedAt: string;
    commitSha: string;
    deploymentStatus: string;
  }): Promise<void>;
  failed(input: {
    publicationId: string;
    category: string;
    retryable: boolean;
  }): Promise<void>;
}
