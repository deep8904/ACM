import postgres, { type Sql, type TransactionSql } from "postgres";

import type { DatabaseConfig } from "./config";
import { normalizeDatabaseError } from "./errors";

export type DatabaseClient = Sql<Record<string, never>>;
export type DatabaseTransaction = TransactionSql<Record<string, never>>;

export function createDatabaseClient(
  config: DatabaseConfig,
  options: { direct?: boolean; maxConnections?: number } = {},
): DatabaseClient {
  const url = options.direct ? (config.directUrl ?? config.url) : config.url;
  return postgres(url, {
    max: options.maxConnections ?? config.maxConnections,
    prepare: false,
    connect_timeout: config.connectTimeoutSeconds,
    idle_timeout: config.idleTimeoutSeconds,
    max_lifetime: 60 * 30,
    onnotice: () => undefined,
  });
}

export async function closeDatabaseClient(sql: DatabaseClient): Promise<void> {
  await sql.end({ timeout: 5 });
}

export async function withTransaction<T>(
  sql: DatabaseClient,
  operation: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  try {
    return (await sql.begin(async (transaction) =>
      operation(transaction),
    )) as unknown as T;
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
}
