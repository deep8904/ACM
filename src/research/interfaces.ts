import type { TopicApprovedEvent, TopicQueueItem } from "../telegram/models";
import type { ResearchJob, ResearchPacket, ResearchSource } from "./models";

export interface ExtractedContent {
  title: string;
  author?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  text: string;
  headings: string[];
  excerpts: string[];
  metadata: Record<string, unknown>;
  warnings: string[];
}
export interface ContentExtractor {
  extract(
    body: string,
    contentType: string,
    fallbackTitle: string,
  ): ExtractedContent;
}
export interface ResearchRetriever {
  retrieve(url: string): Promise<{
    body: string;
    contentType: string;
    finalUrl: string;
    redirects: string[];
  }>;
}

export interface ResearchJobRepository {
  claim(
    eventId: string,
    topicId: string,
    workerId: string,
    now: string,
    staleAfterMs: number,
    recoverableStatuses?: readonly ResearchJob["status"][],
  ): Promise<ResearchJob | undefined>;
  getByEvent(eventId: string): Promise<ResearchJob | undefined>;
  save(job: ResearchJob): Promise<void>;
}
export interface ResearchSourceRepository {
  save(source: ResearchSource, extractedText: string): Promise<void>;
  list(topicId: string): Promise<ResearchSource[]>;
}
export interface ResearchSourceExtensionRepository {
  persist(
    base: ResearchPacket,
    packet: ResearchPacket,
    source: ResearchSource,
    extractedText: string,
  ): Promise<ResearchPacket>;
}
export interface ResearchPacketRepository {
  nextVersion(topicId: string): Promise<number>;
  save(packet: ResearchPacket): Promise<void>;
  get(topicId: string, version?: number): Promise<ResearchPacket | undefined>;
  getByImportHash(
    topicId: string,
    importHash: string,
  ): Promise<ResearchPacket | undefined>;
}
export interface AssistedResearchImportRepository {
  persist(packet: ResearchPacket, importedAt: string): Promise<ResearchPacket>;
}
export interface ResearchCacheRepository {
  get(
    canonicalUrl: string,
  ): Promise<{ source: ResearchSource; text: string } | undefined>;
  put(source: ResearchSource, text: string): Promise<void>;
  getRobots(
    host: string,
  ): Promise<{ body: string; fetchedAt: string } | undefined>;
  putRobots(host: string, body: string, fetchedAt: string): Promise<void>;
}
export interface ApprovedEventRepository {
  next(): Promise<TopicApprovedEvent | undefined>;
  get(id: string): Promise<TopicApprovedEvent | undefined>;
  queue(topicId: string): Promise<TopicQueueItem | undefined>;
  isCancelled(event: TopicApprovedEvent): Promise<boolean>;
  isConsumed(id: string): Promise<boolean>;
  consume(
    id: string,
    packetId: string,
    packetVersion: number,
    at: string,
  ): Promise<void>;
}
export interface ResearchTaskRepository {
  write(
    topicId: string,
    packetVersion: number,
    files: Record<string, string>,
    input: unknown,
  ): Promise<string>;
  readInput(
    topicId: string,
    packetVersion: number,
  ): Promise<unknown | undefined>;
}
