import { z } from "zod";

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);

export const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AI_MODE: z.enum(["assisted", "api"]).default("assisted"),
  TELEGRAM_BOT_TOKEN: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  TELEGRAM_ALLOWED_CHAT_IDS: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  TELEGRAM_ALLOWED_USER_IDS: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  TELEGRAM_WEBHOOK_SECRET_PREVIOUS: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  TELEGRAM_CALLBACK_SECRET: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  TELEGRAM_WEBHOOK_URL: z.preprocess(
    blankToUndefined,
    z.string().url().optional(),
  ),
  TELEGRAM_PARSE_MODE: z.enum(["HTML"]).default("HTML"),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Environment {
  return environmentSchema.parse(source);
}

export const env = parseEnvironment(process.env);
