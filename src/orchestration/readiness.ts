import { checkDatabaseHealth } from "../database/health";
import type { DatabaseClient } from "../database/client";
import { PostgresAutomationJobRepository } from "./repository";

export async function productionReadiness(
  sql: DatabaseClient,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const database = await checkDatabaseHealth(sql);
  const required = [
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
  const missing = required.filter((name) => !environment[name]);
  const jobs = new PostgresAutomationJobRepository(sql);
  const heartbeats = await jobs.heartbeats();
  const latest = new Map(
    heartbeats.map((heartbeat) => [heartbeat.component, heartbeat]),
  );
  const worker = latest.get("worker");
  const scheduler = latest.get("scheduler");
  const webhook = latest.get("webhook");
  const age = (value: typeof worker) =>
    value ? Math.max(0, Date.now() - Date.parse(value.observedAt)) : undefined;
  const components = {
    database: database.healthy ? "healthy" : "unhealthy",
    webhook:
      webhook && (age(webhook) ?? Infinity) < 24 * 60 * 60 * 1000
        ? webhook.status
        : "unknown",
    scheduler:
      scheduler && (age(scheduler) ?? Infinity) < 30 * 60 * 1000
        ? scheduler.status
        : "stale",
    worker:
      worker && (age(worker) ?? Infinity) < 30 * 60 * 1000
        ? worker.status
        : "stale",
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
      components.vercel === "configured",
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
