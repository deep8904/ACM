import type { SourceItem } from "../discovery/models/source-item";
import type { StoryCluster, TopicCandidate } from "../ranking/models";
import type {
  ConversationState,
  MessageIndex,
  ProcessedUpdate,
  TopicApproval,
  TopicApprovedEvent,
  TopicQueueItem,
} from "./models";

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface TopicCard {
  topicId: string;
  text: string;
  buttons: InlineButton[][];
}
export type FinalReviewCard = TopicCard;

export interface SentMessage {
  chatId: string;
  messageId: number;
}

export interface EditorialNotificationAdapter {
  sendTopicRecommendations(
    chatId: string,
    cards: readonly TopicCard[],
  ): Promise<SentMessage[]>;
  updateTopicMessage(
    chatId: string,
    messageId: number,
    card: TopicCard,
  ): Promise<SentMessage>;
  answerCallback(
    callbackQueryId: string,
    text?: string,
    showAlert?: boolean,
  ): Promise<void>;
  sendStatusMessage(chatId: string, text: string): Promise<SentMessage>;
  sendFinalReviewCard(
    chatId: string,
    card: FinalReviewCard,
  ): Promise<SentMessage>;
  updateFinalReviewCard(
    chatId: string,
    messageId: number,
    card: FinalReviewCard,
  ): Promise<SentMessage>;
}

export interface TopicApprovalRepository {
  /** PostgreSQL implementations atomically persist a replacement card set and make it current. */
  activateRankedRun?(
    runId: string,
    origin: RankingRunOrigin,
    eligibleCount: number,
    items: readonly TopicQueueItem[],
  ): Promise<{
    status: "actionable" | "empty" | "superseded";
    items: TopicQueueItem[];
  }>;
  /** Postgres implementations use this to commit the queue decision and outbox atomically. */
  saveDecision?(
    item: TopicQueueItem,
    approval: TopicApproval,
    event: TopicApprovedEvent | undefined,
    expectedQueueVersion: number,
    expectedApprovalVersion?: number,
  ): Promise<void>;
  getById(id: string): Promise<TopicApproval | undefined>;
  getByTopicId(topicId: string): Promise<TopicApproval | undefined>;
  saveApproval(
    approval: TopicApproval,
    expectedVersion?: number,
  ): Promise<TopicApproval>;
  getQueueItem(topicId: string): Promise<TopicQueueItem | undefined>;
  getQueueItemByShortId(shortId: string): Promise<TopicQueueItem | undefined>;
  saveQueueItem(
    item: TopicQueueItem,
    expectedVersion?: number,
  ): Promise<TopicQueueItem>;
  listQueue(): Promise<TopicQueueItem[]>;
  getConversation(
    chatId: string,
    userId: string,
  ): Promise<ConversationState | undefined>;
  saveConversation(state: ConversationState): Promise<void>;
  clearConversation(chatId: string, userId: string): Promise<void>;
  getMessageIndex(shortId: string): Promise<MessageIndex | undefined>;
  saveMessageIndex(index: MessageIndex): Promise<void>;
  claimUpdate(
    updateId: number,
    callbackQueryId: string | undefined,
    now: string,
  ): Promise<boolean>;
  completeUpdate(record: ProcessedUpdate): Promise<void>;
  releaseUpdate(updateId: number, callbackQueryId?: string): Promise<void>;
  hasProcessedUpdate(updateId: number): Promise<boolean>;
  saveApprovedEvent(event: TopicApprovedEvent): Promise<boolean>;
  getApprovedEventByTopicId(
    topicId: string,
  ): Promise<TopicApprovedEvent | undefined>;
  updateApprovedEvent(
    event: TopicApprovedEvent,
    expectedVersion: number,
  ): Promise<void>;
  listApprovedEvents(): Promise<TopicApprovedEvent[]>;
}

export interface RankedRun {
  runId: string;
  candidates: TopicCandidate[];
  clusters: StoryCluster[];
  sourceItems: SourceItem[];
}

export interface TopicCatalog {
  getRun(runId?: string): Promise<RankedRun>;
  latestRunId(): Promise<string>;
}

export type RankingRunOrigin = "scheduled" | "manual_test" | "other";

export type DnsLookup = (hostname: string) => Promise<readonly string[]>;
