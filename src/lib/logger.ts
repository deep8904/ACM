import { env } from "../config/env";

export const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];

export interface LogContext {
  runId?: string;
  stage: string;
  topicId?: string;
  articleId?: string;
  provider?: string;
  durationMs?: number;
  attempt?: number;
  approvalId?: string;
  telegramUpdateId?: number;
  telegramChatId?: string;
  action?: string;
  result?: string;
}

export interface LogRecord extends LogContext {
  timestamp: string;
  level: LogLevel;
  message: string;
}

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogRecord(
  level: LogLevel,
  message: string,
  context: LogContext,
  timestamp = new Date(),
): LogRecord {
  return {
    timestamp: timestamp.toISOString(),
    level,
    message,
    ...context,
  };
}

export function log(
  level: LogLevel,
  message: string,
  context: LogContext,
): void {
  if (levelPriority[level] < levelPriority[env.LOG_LEVEL]) {
    return;
  }

  const serialized = JSON.stringify(createLogRecord(level, message, context));

  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}
