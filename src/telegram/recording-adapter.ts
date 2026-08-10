import type {
  EditorialNotificationAdapter,
  SentMessage,
  TopicCard,
} from "./interfaces";

export type RecordedTelegramCall =
  | { method: "sendTopicRecommendations"; chatId: string; cards: TopicCard[] }
  | {
      method: "updateTopicMessage";
      chatId: string;
      messageId: number;
      card: TopicCard;
    }
  | {
      method: "answerCallback";
      callbackQueryId: string;
      text?: string;
      showAlert: boolean;
    }
  | { method: "sendStatusMessage"; chatId: string; text: string }
  | { method: "sendFinalReviewCard"; chatId: string; card: TopicCard }
  | {
      method: "updateFinalReviewCard";
      chatId: string;
      messageId: number;
      card: TopicCard;
    };

export class RecordingTelegramAdapter implements EditorialNotificationAdapter {
  readonly calls: RecordedTelegramCall[] = [];
  private nextMessageId = 1000;

  async sendTopicRecommendations(
    chatId: string,
    cards: readonly TopicCard[],
  ): Promise<SentMessage[]> {
    this.calls.push({
      method: "sendTopicRecommendations",
      chatId,
      cards: [...cards],
    });
    return cards.map(() => ({ chatId, messageId: this.nextMessageId++ }));
  }

  async updateTopicMessage(
    chatId: string,
    messageId: number,
    card: TopicCard,
  ): Promise<SentMessage> {
    this.calls.push({ method: "updateTopicMessage", chatId, messageId, card });
    return { chatId, messageId };
  }

  async answerCallback(
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<void> {
    this.calls.push({
      method: "answerCallback",
      callbackQueryId,
      text,
      showAlert,
    });
  }

  async sendStatusMessage(chatId: string, text: string): Promise<SentMessage> {
    this.calls.push({ method: "sendStatusMessage", chatId, text });
    return { chatId, messageId: this.nextMessageId++ };
  }

  async sendFinalReviewCard(chatId: string, card: TopicCard) {
    this.calls.push({ method: "sendFinalReviewCard", chatId, card });
    return { chatId, messageId: this.nextMessageId++ };
  }

  async updateFinalReviewCard(
    chatId: string,
    messageId: number,
    card: TopicCard,
  ) {
    this.calls.push({
      method: "updateFinalReviewCard",
      chatId,
      messageId,
      card,
    });
    return { chatId, messageId };
  }
}
