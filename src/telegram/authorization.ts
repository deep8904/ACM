import { TelegramControlError } from "./errors";
import type { TelegramEnvironment } from "./config";

export interface TelegramActor {
  chatId: string;
  userId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
}

export function authorizeActor(
  actor: TelegramActor,
  config: TelegramEnvironment,
): void {
  if (
    config.TELEGRAM_DEV_ALLOW_UNAUTHORIZED &&
    config.NODE_ENV !== "production"
  )
    return;
  if (
    config.TELEGRAM_ALLOWED_CHAT_IDS.length === 0 ||
    config.TELEGRAM_ALLOWED_USER_IDS.length === 0
  ) {
    throw new TelegramControlError(
      "unauthorized",
      "Telegram authorization is not configured",
      503,
    );
  }
  const chatAllowed = config.TELEGRAM_ALLOWED_CHAT_IDS.includes(actor.chatId);
  const userAllowed = config.TELEGRAM_ALLOWED_USER_IDS.includes(actor.userId);
  if (!chatAllowed || !userAllowed || actor.chatType === "channel") {
    throw new TelegramControlError(
      "unauthorized",
      "This Telegram account is not authorized",
      403,
    );
  }
}

export function privacySafeChatId(chatId: string): string {
  const suffix = chatId.replace("-", "").slice(-4);
  return chatId.startsWith("-") ? `group:…${suffix}` : `private:…${suffix}`;
}
