import type { TopicApprovedEvent, TopicQueueItem } from "../telegram/models";
import type { ResearchPacket } from "../research/models";
import type {
  ArticleDraft,
  ArticleHistoryEntry,
  ArticleWritingResult,
  DraftQualityReport,
  WritingJob,
} from "./models";

export interface WritingJobRepository {
  claim(
    topicId: string,
    packet: ResearchPacket,
    articleType: WritingJob["articleType"],
    configHash: string,
    workerId: string,
    now: string,
  ): Promise<WritingJob | undefined>;
  get(
    topicId: string,
    researchVersion?: number,
  ): Promise<WritingJob | undefined>;
  getById(id: string): Promise<WritingJob | undefined>;
  save(job: WritingJob): Promise<void>;
}
export interface ArticleDraftRepository {
  nextVersion(topicId: string): Promise<number>;
  get(topicId: string, version?: number): Promise<ArticleDraft | undefined>;
  findByImportHash(hash: string): Promise<ArticleDraft | undefined>;
  saveBundle(
    draft: ArticleDraft,
    mdx: string,
    plainText: string,
    quality: DraftQualityReport,
    imported: unknown,
  ): Promise<void>;
}
export interface DraftQualityRepository {
  get(
    topicId: string,
    version?: number,
  ): Promise<DraftQualityReport | undefined>;
}
export interface ArticleHistoryRepository {
  list(): Promise<ArticleHistoryEntry[]>;
  add(entry: ArticleHistoryEntry): Promise<void>;
}
export interface WritingTaskRepository {
  write(
    topicId: string,
    researchVersion: number,
    files: Record<string, string>,
  ): Promise<string>;
  readInput(
    topicId: string,
    researchVersion: number,
  ): Promise<unknown | undefined>;
}
export interface WritingGateRepository {
  event(id: string): Promise<TopicApprovedEvent | undefined>;
  queue(topicId: string): Promise<TopicQueueItem | undefined>;
}
export interface ArticleWriterProvider {
  generate(task: unknown): Promise<ArticleWritingResult>;
}
