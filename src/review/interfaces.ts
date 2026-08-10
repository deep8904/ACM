import type { ResearchPacket } from "../research/models";
import type { ArticleDraft, DraftQualityReport } from "../writing/models";
import type {
  ArticleFinalApprovedEvent,
  DeterministicEditorialReport,
  DraftPreview,
  EditorialIssue,
  EditorialReviewJob,
  EditorialReviewResult,
  FinalApprovalRecord,
  FinalConversationState,
  RevisionRequest,
} from "./models";

export interface EditorialReviewJobRepository {
  claim(
    draft: ArticleDraft,
    workerId: string,
    now: string,
  ): Promise<EditorialReviewJob>;
  get(
    topicId: string,
    draftVersion: number,
  ): Promise<EditorialReviewJob | undefined>;
  getById(id: string): Promise<EditorialReviewJob | undefined>;
  save(job: EditorialReviewJob): Promise<void>;
}
export interface EditorialReviewRepository {
  nextVersion(topicId: string, draftVersion: number): Promise<number>;
  get(
    topicId: string,
    draftVersion: number,
    reviewVersion?: number,
  ): Promise<EditorialReviewResult | undefined>;
  findByImportHash(hash: string): Promise<EditorialReviewResult | undefined>;
  save(
    review: EditorialReviewResult,
    deterministic: DeterministicEditorialReport,
    provenance: unknown,
  ): Promise<void>;
  resolveIssues(
    topicId: string,
    draftVersion: number,
    issueIds: string[],
    revisedDraftVersion: number,
    resolvedAt: string,
  ): Promise<void>;
}
export interface EditorialIssueRepository {
  list(
    topicId: string,
    draftVersion: number,
    reviewVersion?: number,
  ): Promise<EditorialIssue[]>;
}
export interface ReviewTaskRepository {
  write(
    topicId: string,
    draftVersion: number,
    files: Record<string, string>,
  ): Promise<string>;
  readInput(
    topicId: string,
    draftVersion: number,
  ): Promise<unknown | undefined>;
}
export interface RevisionTaskRepository {
  write(
    topicId: string,
    draftVersion: number,
    files: Record<string, string>,
  ): Promise<string>;
  readInput(
    topicId: string,
    draftVersion: number,
  ): Promise<unknown | undefined>;
  saveRequest(request: RevisionRequest): Promise<void>;
  getRequest(
    topicId: string,
    draftVersion: number,
  ): Promise<RevisionRequest | undefined>;
  saveResolution(
    topicId: string,
    draftVersion: number,
    issueIds: string[],
    revisedDraftVersion: number,
    resolvedAt: string,
  ): Promise<void>;
}
export interface FinalApprovalRepository {
  /** Durable implementations commit the approval and final-event outbox together. */
  saveWithEvent?(
    record: FinalApprovalRecord,
    event: ArticleFinalApprovedEvent | undefined,
    expectedEventVersion?: number,
  ): Promise<boolean>;
  get(
    topicId: string,
    version?: number,
  ): Promise<FinalApprovalRecord | undefined>;
  getByShortId(shortId: string): Promise<FinalApprovalRecord | undefined>;
  save(record: FinalApprovalRecord): Promise<void>;
  list(): Promise<FinalApprovalRecord[]>;
}
export interface FinalApprovedEventRepository {
  get(topicId: string): Promise<ArticleFinalApprovedEvent | undefined>;
  save(event: ArticleFinalApprovedEvent): Promise<boolean>;
  update(
    event: ArticleFinalApprovedEvent,
    expectedVersion: number,
  ): Promise<void>;
}
export interface DraftPreviewRepository {
  save(preview: DraftPreview, html: string): Promise<string>;
  get(topicId: string, draftVersion: number): Promise<DraftPreview | undefined>;
  supersede(topicId: string, draftVersion: number, now: string): Promise<void>;
}
export interface FinalConversationRepository {
  get(
    chatId: string,
    userId: string,
  ): Promise<FinalConversationState | undefined>;
  save(state: FinalConversationState): Promise<void>;
  clear(chatId: string, userId: string): Promise<void>;
}
export interface ReviewGateRepository {
  packet(topicId: string, version: number): Promise<ResearchPacket | undefined>;
  quality(
    topicId: string,
    draftVersion: number,
  ): Promise<DraftQualityReport | undefined>;
  topicActive(topicId: string, approvedEventId: string): Promise<boolean>;
  topicOrigin(
    topicId: string,
  ): Promise<"ranked" | "manual_topic" | "manual_url" | undefined>;
}
export interface EditorialReviewerProvider {
  review(task: unknown): Promise<unknown>;
}
