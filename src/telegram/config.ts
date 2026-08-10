import { resolve } from "node:path";

import { z } from "zod";

import { TelegramControlError } from "./errors";

const optional = (value: unknown) => (value === "" ? undefined : value);
function idList(pattern: RegExp, label: string) {
  return z
    .preprocess(optional, z.string().optional())
    .transform((value, context) => {
      if (!value) return [];
      const values = value.split(",").map((part) => part.trim());
      if (values.some((part) => !pattern.test(part))) {
        context.addIssue({
          code: "custom",
          message: `${label} must be comma-separated numeric IDs`,
        });
        return z.NEVER;
      }
      return [...new Set(values)];
    });
}

export const telegramEnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  TELEGRAM_BOT_TOKEN: z.preprocess(optional, z.string().min(20).optional()),
  TELEGRAM_ALLOWED_CHAT_IDS: idList(/^-?\d+$/, "Chat IDs"),
  TELEGRAM_ALLOWED_USER_IDS: idList(/^\d+$/, "User IDs"),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(
    optional,
    z.string().min(16).optional(),
  ),
  TELEGRAM_WEBHOOK_SECRET_PREVIOUS: z.preprocess(
    optional,
    z.string().min(16).optional(),
  ),
  TELEGRAM_CALLBACK_SECRET: z.preprocess(
    optional,
    z.string().min(16).optional(),
  ),
  TELEGRAM_WEBHOOK_URL: z.preprocess(optional, z.string().url().optional()),
  TELEGRAM_PARSE_MODE: z.enum(["HTML"]).default("HTML"),
  TELEGRAM_STATE_DIRECTORY: z.string().default("data/telegram"),
  TELEGRAM_RUNS_DIRECTORY: z.string().default("data/runs"),
  TELEGRAM_CONVERSATION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(30),
  TELEGRAM_TOPIC_EXPIRY_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(720)
    .default(168),
  TELEGRAM_RECOMMENDATION_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3),
  TELEGRAM_MAX_SOURCE_PREVIEW: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5),
  TELEGRAM_DEV_ALLOW_UNAUTHORIZED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type TelegramEnvironment = z.infer<typeof telegramEnvironmentSchema>;

export function parseTelegramEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): TelegramEnvironment {
  return telegramEnvironmentSchema.parse(source);
}

export interface TelegramRuntimeConfig extends TelegramEnvironment {
  stateDirectory: string;
  runsDirectory: string;
  webhookSecrets: string[];
  callbackSecret: string;
}

export function requireTelegramRuntimeConfig(
  source: Readonly<Record<string, string | undefined>>,
  purpose: "webhook" | "api" | "replay",
): TelegramRuntimeConfig {
  const config = parseTelegramEnvironment(source);
  if (purpose !== "replay" && !config.TELEGRAM_BOT_TOKEN) {
    throw new TelegramControlError(
      "telegram_api_failure",
      "Telegram bot token is not configured",
      503,
    );
  }
  if (purpose === "webhook" && !config.TELEGRAM_WEBHOOK_SECRET) {
    throw new TelegramControlError(
      "unauthorized",
      "Telegram webhook secret is not configured",
      503,
    );
  }
  if (
    purpose !== "replay" &&
    config.TELEGRAM_ALLOWED_CHAT_IDS.length === 0 &&
    config.TELEGRAM_ALLOWED_USER_IDS.length === 0
  ) {
    throw new TelegramControlError(
      "unauthorized",
      "Telegram authorization is not configured",
      503,
    );
  }
  const callbackSecret =
    config.TELEGRAM_CALLBACK_SECRET ?? config.TELEGRAM_WEBHOOK_SECRET;
  if (!callbackSecret) {
    throw new TelegramControlError(
      "unauthorized",
      "Telegram callback signing secret is not configured",
      503,
    );
  }
  return {
    ...config,
    stateDirectory: resolve(config.TELEGRAM_STATE_DIRECTORY),
    runsDirectory: resolve(config.TELEGRAM_RUNS_DIRECTORY),
    webhookSecrets: [
      config.TELEGRAM_WEBHOOK_SECRET,
      config.TELEGRAM_WEBHOOK_SECRET_PREVIOUS,
    ].filter((value): value is string => Boolean(value)),
    callbackSecret,
  };
}
