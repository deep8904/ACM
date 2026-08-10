import { closeDatabaseClient, createDatabaseClient } from "./client";
import { readStorageConfiguration } from "./config";
import { redactDatabaseSecrets } from "./errors";
import { checkDatabaseHealth } from "./health";

export type ReadinessState =
  | "LOCAL_READY"
  | "DATABASE_CODE_READY"
  | "DATABASE_CONNECTED"
  | "DATABASE_MIGRATED"
  | "DATABASE_PARITY_VERIFIED"
  | "STAGING_READY"
  | "PRODUCTION_READY";

async function main(): Promise<void> {
  const storage = readStorageConfiguration();
  const checks = {
    code: true,
    backendPostgres: storage.backend === "postgres",
    connectionConfigured: Boolean(storage.database),
    connected: false,
    migrated: false,
    parityVerified: process.env.DATABASE_PARITY_VERIFIED === "true",
    stagingVerified: process.env.STAGING_VERIFIED === "true",
    productionExplicitlyEnabled:
      process.env.PRODUCTION_DURABLE_STORAGE_VERIFIED === "true",
  };
  let state: ReadinessState = "DATABASE_CODE_READY";
  if (!storage.database) {
    console.log(JSON.stringify({ state, checks }, null, 2));
    return;
  }
  const sql = createDatabaseClient(storage.database, { maxConnections: 1 });
  try {
    const health = await checkDatabaseHealth(sql);
    checks.connected = health.connected;
    checks.migrated = health.healthy;
    if (checks.connected) state = "DATABASE_CONNECTED";
    if (checks.migrated) state = "DATABASE_MIGRATED";
    if (checks.migrated && checks.parityVerified)
      state = "DATABASE_PARITY_VERIFIED";
    if (state === "DATABASE_PARITY_VERIFIED" && checks.stagingVerified)
      state = "STAGING_READY";
    if (
      state === "STAGING_READY" &&
      checks.productionExplicitlyEnabled &&
      checks.backendPostgres &&
      storage.production
    )
      state = "PRODUCTION_READY";
    console.log(
      JSON.stringify(
        {
          state,
          checks,
          database: {
            currentMigration: health.currentMigration,
            expectedMigration: health.expectedMigration,
            missingTables: health.missingTables,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDatabaseClient(sql);
  }
}

main().catch((error: unknown) => {
  console.error(
    redactDatabaseSecrets(
      error instanceof Error ? error.message : String(error),
    ),
  );
  process.exitCode = 1;
});
