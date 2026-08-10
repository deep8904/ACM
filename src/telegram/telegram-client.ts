import { z } from "zod";

import type { FetchImplementation } from "../discovery/adapters/types";
import {
  log as defaultLog,
  type LogContext,
  type LogLevel,
} from "../lib/logger";
import { TelegramApiError } from "./errors";
import type {
  EditorialNotificationAdapter,
  SentMessage,
  TopicCard,
} from "./interfaces";

const apiEnvelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
  parameters: z
    .object({ retry_after: z.number().int().positive().optional() })
    .optional(),
});
const sentMessageSchema = z.object({
  message_id: z.number().int().nonnegative(),
  chat: z.object({ id: z.number().int() }),
});

export interface TelegramClientOptions {
  botToken: string;
  fetch?: FetchImplementation;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: (level: LogLevel, message: string, context: LogContext) => void;
}

export class TelegramBotApiClient implements EditorialNotificationAdapter {
  private readonly fetchImplementation: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: (
    level: LogLevel,
    message: string,
    context: LogContext,
  ) => void;

  constructor(private readonly options: TelegramClientOptions) {
    this.fetchImplementation =
      options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.logger = options.logger ?? defaultLog;
  }

  async sendTopicRecommendations(
    chatId: string,
    cards: readonly TopicCard[],
  ): Promise<SentMessage[]> {
    const results: SentMessage[] = [];
    for (const card of cards) results.push(await this.sendCard(chatId, card));
    return results;
  }

  async updateTopicMessage(
    chatId: string,
    messageId: number,
    card: TopicCard,
  ): Promise<SentMessage> {
    const result = sentMessageSchema.parse(
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard(card),
      }),
    );
    return { chatId: String(result.chat.id), messageId: result.message_id };
  }

  async answerCallback(
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  async sendStatusMessage(chatId: string, text: string): Promise<SentMessage> {
    const result = sentMessageSchema.parse(
      await this.call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    );
    return { chatId: String(result.chat.id), messageId: result.message_id };
  }

  sendFinalReviewCard(chatId: string, card: TopicCard): Promise<SentMessage> {
    return this.sendCard(chatId, card);
  }

  updateFinalReviewCard(
    chatId: string,
    messageId: number,
    card: TopicCard,
  ): Promise<SentMessage> {
    return this.updateTopicMessage(chatId, messageId, card);
  }

  async setWebhook(url: string, secretToken: string): Promise<boolean> {
    return z.boolean().parse(
      await this.call("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    );
  }

  async getWebhookInfo(): Promise<unknown> {
    return this.call("getWebhookInfo", {});
  }

  async deleteWebhook(): Promise<boolean> {
    return z
      .boolean()
      .parse(await this.call("deleteWebhook", { drop_pending_updates: false }));
  }

  private async sendCard(
    chatId: string,
    card: TopicCard,
  ): Promise<SentMessage> {
    const result = sentMessageSchema.parse(
      await this.call("sendMessage", {
        chat_id: chatId,
        text: card.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard(card),
      }),
    );
    return { chatId: String(result.chat.id), messageId: result.message_id };
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImplementation(
          `https://api.telegram.org/bot${this.options.botToken}/${method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        const envelope = apiEnvelopeSchema.parse(
          JSON.parse(await response.text()) as unknown,
        );
        if (response.ok && envelope.ok) return envelope.result;
        const retryAfter = envelope.parameters?.retry_after;
        const error = new TelegramApiError(
          `Telegram ${method} failed${envelope.error_code ? ` with code ${envelope.error_code}` : ""}`,
          method,
          envelope.error_code,
          retryAfter,
        );
        if (
          !transient(response.status, envelope.error_code) ||
          attempt === this.maxRetries
        )
          throw error;
        this.logger("warn", "Telegram API transient failure", {
          stage: "AWAITING_TOPIC_APPROVAL",
          provider: "telegram",
          attempt: attempt + 1,
          action: method,
          result: "retry",
        });
        await this.sleep(retryAfter ? retryAfter * 1000 : 200 * 2 ** attempt);
      } catch (error) {
        lastError = error;
        const retryable =
          !(error instanceof TelegramApiError) ||
          error.telegramErrorCode === 429 ||
          (error.telegramErrorCode !== undefined &&
            error.telegramErrorCode >= 500);
        if (!retryable || attempt === this.maxRetries) {
          if (error instanceof TelegramApiError) throw error;
          throw new TelegramApiError(
            `Telegram ${method} request failed`,
            method,
            undefined,
            undefined,
            { cause: error },
          );
        }
        await this.sleep(200 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new TelegramApiError(
      `Telegram ${method} request failed`,
      method,
      undefined,
      undefined,
      { cause: lastError },
    );
  }
}

function keyboard(card: TopicCard): Record<string, unknown> {
  return {
    inline_keyboard: card.buttons.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      })),
    ),
  };
}

function transient(status: number, code?: number): boolean {
  return (
    status === 429 ||
    status === 408 ||
    status >= 500 ||
    code === 429 ||
    (code !== undefined && code >= 500)
  );
}
