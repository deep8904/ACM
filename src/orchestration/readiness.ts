import { checkDatabaseHealth } from "../database/health";
import type { DatabaseClient } from "../database/client";
import type { SystemHeartbeat } from "./models";
import { PostgresAutomationJobRepository } from "./repository";

const SCHEDULER_MAX_AGE_MS = 30 * 60 * 1000;
const WORKER_MAX_AGE_MS = 30 * 60 * 1000;
const WEBHOOK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const REQUIRED_PRODUCTION_ENVIRONMENT = [
  "STORAGE_BACKEND",
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_CALLBACK_SECRET",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_ALLOWED_USER_IDS",
  "BLOG_GITHUB_TOKEN",
  "BLOG_REPOSITORY",
  "SITE_ORIGIN",
  "CONTROL_PLANE_ORIGIN",
  "CRON_SECRET",
  "GOOGLE_AI_API_KEY",
] as const;

export function evaluateAutomationHeartbeats(
  heartbeats: SystemHeartbeat[],
  now = new Date(),
) {
  const latest = new Map(
    heartbeats.map((heartbeat) => [heartbeat.component, heartbeat]),
  );
  const worker = latest.get("worker");
  const scheduler = latest.get("scheduler");
  const webhook = latest.get("webhook");
  const age = (value: SystemHeartbeat | undefined) =>
    value
      ? Math.max(0, now.getTime() - Date.parse(value.observedAt))
      : undefined;
  const schedulerSource =
    typeof scheduler?.details.source === "string"
      ? scheduler.details.source
      : "unknown";

  return {
    webhook:
      webhook && (age(webhook) ?? Infinity) < WEBHOOK_MAX_AGE_MS
        ? webhook.status
        : "unknown",
    scheduler:
      scheduler &&
      schedulerSource === "github_actions" &&
      (age(scheduler) ?? Infinity) < SCHEDULER_MAX_AGE_MS
        ? scheduler.status
        : "stale",
    schedulerSource,
    worker:
      worker && (age(worker) ?? Infinity) < WORKER_MAX_AGE_MS
        ? worker.status
        : "stale",
  };
}

export async function productionReadiness(
  sql: DatabaseClient,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const database = await checkDatabaseHealth(sql);
  const missing = REQUIRED_PRODUCTION_ENVIRONMENT.filter(
    (name) => !environment[name],
  );
  const jobs = new PostgresAutomationJobRepository(sql);
  const heartbeats = await jobs.heartbeats();
  const automation = evaluateAutomationHeartbeats(heartbeats);
  const components = {
    database: database.healthy ? "healthy" : "unhealthy",
    webhook: automation.webhook,
    scheduler: automation.scheduler,
    schedulerSource: automation.schedulerSource,
    worker: automation.worker,
    github:
      environment.BLOG_GITHUB_TOKEN && environment.BLOG_REPOSITORY
        ? "configured"
        : "missing",
    vercel:
      environment.VERCEL_DEPLOYMENT_METADATA_SOURCE === "github" ||
      (environment.VERCEL_TOKEN && environment.VERCEL_PROJECT_ID)
        ? "configured"
        : "missing",
    llm: environment.GOOGLE_AI_API_KEY ? "configured" : "missing",
  };
  return {
    ready:
      database.healthy &&
      missing.length === 0 &&
      components.vercel === "configured" &&
      components.scheduler === "healthy" &&
      components.worker === "healthy",
    database: {
      healthy: database.healthy,
      migration: `${database.currentMigration}/${database.expectedMigration}`,
      missingTables: database.missingTables,
    },
    components,
    missing,
    checkedAt: new Date().toISOString(),
  };
}
