import { closeDatabaseClient, createDatabaseClient } from "./client";
import { readStorageConfiguration, safeDatabaseTarget } from "./config";
import { redactDatabaseSecrets } from "./errors";
import { checkDatabaseHealth } from "./health";
import { migrateDatabase, migrationStatus } from "./migrations";

type Command = "status" | "migrate" | "check" | "verify" | "health";

async function main(): Promise<void> {
  const command = (process.argv[2] ?? "status") as Command;
  if (!["status", "migrate", "check", "verify", "health"].includes(command)) {
    throw new Error(`Unknown database command: ${command}`);
  }
  const storage = readStorageConfiguration();
  if (!storage.database) {
    console.log(
      JSON.stringify(
        {
          configured: false,
          backend: storage.backend,
          message: "DATABASE_URL is not configured",
        },
        null,
        2,
      ),
    );
    if (command !== "status") process.exitCode = 1;
    return;
  }
  const target = safeDatabaseTarget(storage.database);
  const sql = createDatabaseClient(storage.database, {
    direct: command === "migrate",
    maxConnections: 1,
  });
  try {
    if (command === "migrate") {
      const result = await migrateDatabase(sql);
      console.log(
        JSON.stringify({ configured: true, target, ...result }, null, 2),
      );
      return;
    }
    if (command === "status") {
      const status = await migrationStatus(sql);
      console.log(
        JSON.stringify(
          { configured: true, backend: storage.backend, target, ...status },
          null,
          2,
        ),
      );
      return;
    }
    const health = await checkDatabaseHealth(sql);
    console.log(JSON.stringify({ target, ...health }, null, 2));
    if (!health.healthy) process.exitCode = 1;
  } finally {
    await closeDatabaseClient(sql);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactDatabaseSecrets(message));
  process.exitCode = 1;
});
