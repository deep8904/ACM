import type { DatabaseClient } from "./client";
import { migrationStatus } from "./migrations";

export const CRITICAL_TABLES = [
  "topic_queue_items",
  "topic_approvals",
  "telegram_updates",
  "topic_approved_events",
  "research_jobs",
  "research_packets",
  "writing_jobs",
  "article_drafts",
  "editorial_reviews",
  "final_approvals",
  "final_approved_events",
  "publication_jobs",
  "publications",
  "publication_republishes",
  "production_publication_artifacts",
  "social_generation_jobs",
  "social_packages",
  "social_distribution_plans",
  "social_distribution_events",
  "social_assets",
  "analytics_imports",
  "performance_snapshots",
  "automation_jobs",
  "automation_heartbeats",
  "llm_invocations",
  "research_remediation_conversations",
  "research_remediation_events",
] as const;

export interface DatabaseHealth {
  connected: boolean;
  schemaPresent: boolean;
  migrationsCurrent: boolean;
  migrationsValid: boolean;
  currentMigration: string;
  expectedMigration: string;
  missingTables: string[];
  serverVersion: string;
  healthy: boolean;
}

export async function checkDatabaseHealth(
  sql: DatabaseClient,
): Promise<DatabaseHealth> {
  const [server] = await sql<{ server_version: string }[]>`show server_version`;
  const [schema] = await sql<{ present: boolean }[]>`
    select exists(select 1 from information_schema.schemata where schema_name = 'content_machine') as present
  `;
  const status = await migrationStatus(sql);
  const tableRows = schema?.present
    ? await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'content_machine' and table_type = 'BASE TABLE'
      `
    : [];
  const tables = new Set(tableRows.map((row) => row.table_name));
  const missingTables = CRITICAL_TABLES.filter((table) => !tables.has(table));
  const migrationsCurrent =
    status.current === status.expected && status.pending.length === 0;
  const healthy = Boolean(
    schema?.present &&
    migrationsCurrent &&
    status.valid &&
    missingTables.length === 0,
  );
  return {
    connected: true,
    schemaPresent: Boolean(schema?.present),
    migrationsCurrent,
    migrationsValid: status.valid,
    currentMigration: status.current,
    expectedMigration: status.expected,
    missingTables,
    serverVersion: server?.server_version ?? "unknown",
    healthy,
  };
}
