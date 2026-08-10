export type TelegramErrorCode =
  | "unauthorized"
  | "invalid_command"
  | "missing_topic"
  | "expired_topic"
  | "stale_callback"
  | "duplicate_update"
  | "invalid_url"
  | "queue_conflict"
  | "telegram_api_failure"
  | "persistence_failure"
  | "invalid_state_transition"
  | "production_durability_unavailable";

export class TelegramControlError extends Error {
  constructor(
    public readonly code: TelegramErrorCode,
    message: string,
    public readonly statusCode = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelegramControlError";
  }
}

export class TelegramApiError extends TelegramControlError {
  constructor(
    message: string,
    public readonly method: string,
    public readonly telegramErrorCode?: number,
    public readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super("telegram_api_failure", message, 502, options);
    this.name = "TelegramApiError";
  }
}
