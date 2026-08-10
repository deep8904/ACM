import type { ProductionPublicationArtifact } from "../publication/models";
import type {
  SocialApproval,
  SocialExport,
  SocialGenerationJob,
  SocialHistory,
  SocialPackage,
  SocialQuality,
  PostedRecord,
  SocialRevision,
  SocialConversation,
  SocialAsset,
  SocialDistributionEvent,
  SocialDistributionPlan,
  SocialPlatform,
  SocialPublisherCapabilities,
  PlatformContentItem,
} from "./models";
export interface PublishedArticleContentRepository {
  get(record: ProductionPublicationArtifact): Promise<string | undefined>;
}
export interface SocialGenerationJobRepository {
  claim(
    record: ProductionPublicationArtifact,
    workerId: string,
    now: string,
  ): Promise<SocialGenerationJob>;
  get(publicationId: string): Promise<SocialGenerationJob | undefined>;
  save(job: SocialGenerationJob): Promise<void>;
}
export interface SocialPackageRepository {
  nextVersion(publicationId: string): Promise<number>;
  get(
    publicationId: string,
    version?: number,
  ): Promise<SocialPackage | undefined>;
  findByImportHash(hash: string): Promise<SocialPackage | undefined>;
  save(
    pkg: SocialPackage,
    quality: SocialQuality[],
    provenance: unknown,
  ): Promise<void>;
}
export interface SocialQualityRepository {
  get(publicationId: string, version: number): Promise<SocialQuality[]>;
}
export interface SocialApprovalRepository {
  get(packageId: string, itemId: string): Promise<SocialApproval | undefined>;
  save(value: SocialApproval): Promise<void>;
  list(packageId: string): Promise<SocialApproval[]>;
}
export interface SocialHistoryRepository {
  list(): Promise<SocialHistory[]>;
  add(value: SocialHistory): Promise<void>;
}
export interface SocialExportRepository {
  write(
    publicationId: string,
    version: number,
    files: Record<string, string>,
    records: SocialExport[],
  ): Promise<SocialExport[]>;
  list(publicationId: string, version: number): Promise<SocialExport[]>;
  readFiles(
    publicationId: string,
    version: number,
  ): Promise<Record<string, string>>;
  location(publicationId: string, version: number): string;
}
export interface SocialTaskRepository {
  write(
    publicationId: string,
    version: number,
    files: Record<string, string>,
  ): Promise<string>;
  readInput(
    publicationId: string,
    version: number,
  ): Promise<unknown | undefined>;
}
export interface SocialPostedRepository {
  save(value: PostedRecord): Promise<void>;
  get(
    publicationId: string,
    platform: string,
  ): Promise<PostedRecord | undefined>;
}
export interface SocialRevisionRepository {
  write(
    publicationId: string,
    version: number,
    files: Record<string, string>,
    request: SocialRevision,
  ): Promise<string>;
  get(
    publicationId: string,
    version: number,
  ): Promise<SocialRevision | undefined>;
}
export interface SocialConversationRepository {
  get(chatId: string, userId: string): Promise<SocialConversation | undefined>;
  save(value: SocialConversation): Promise<void>;
  clear(chatId: string, userId: string): Promise<void>;
}
export interface SocialDistributionPlanRepository {
  get(id: string): Promise<SocialDistributionPlan | undefined>;
  getByPublication(
    publicationId: string,
  ): Promise<SocialDistributionPlan | undefined>;
  getByShortId(shortId: string): Promise<SocialDistributionPlan | undefined>;
  save(value: SocialDistributionPlan): Promise<void>;
  appendEvent(value: SocialDistributionEvent): Promise<boolean>;
  listEvents(planId: string): Promise<SocialDistributionEvent[]>;
}
export interface SocialAssetRepository {
  findByContentHash(
    planId: string,
    contentHash: string,
  ): Promise<SocialAsset | undefined>;
  save(value: SocialAsset, bytes: Uint8Array): Promise<SocialAsset>;
  list(planId: string): Promise<SocialAsset[]>;
  read(assetId: string): Promise<Uint8Array | undefined>;
}
export interface SocialPublisher {
  readonly id: string;
  readonly platform: SocialPlatform | "manual";
  capabilities(): SocialPublisherCapabilities;
  isConfigured(): boolean;
  publish(input: {
    idempotencyKey: string;
    platform: SocialPlatform;
    items: PlatformContentItem[];
    assets: SocialAsset[];
  }): Promise<{
    confirmed: boolean;
    postUrl?: string;
    providerPostId?: string;
  }>;
}
export interface SocialGeneratorProvider {
  generate(task: unknown): Promise<unknown>;
}
