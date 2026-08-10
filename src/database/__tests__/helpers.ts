import {
  createDatabaseClient,
  closeDatabaseClient,
  type DatabaseClient,
} from "../client";
import { it } from "vitest";
import { EXPECTED_DATABASE_SCHEMA, type DatabaseConfig } from "../config";
import { migrateDatabase } from "../migrations";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const postgresTest = testDatabaseUrl ? it : it.skip;

export async function testClient(): Promise<DatabaseClient> {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not configured");
  const config: DatabaseConfig = {
    url: testDatabaseUrl,
    directUrl: process.env.TEST_DATABASE_DIRECT_URL,
    schema: EXPECTED_DATABASE_SCHEMA,
    maxConnections: 4,
    connectTimeoutSeconds: 10,
    idleTimeoutSeconds: 10,
  };
  const sql = createDatabaseClient(config);
  await migrateDatabase(sql);
  return sql;
}

export { closeDatabaseClient };

export function suffix(): string {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
