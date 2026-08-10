import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  type DatabaseClient,
  type DatabaseTransaction,
  withTransaction,
} from "./client";
import { DurableStorageError, normalizeDatabaseError } from "./errors";

export const MIGRATIONS_DIRECTORY = path.resolve(
  process.cwd(),
  "database/migrations",
);
const migrationPattern = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const advisoryLockKey = 4_247_182_936;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

export async function loadMigrations(
  directory = MIGRATIONS_DIRECTORY,
): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => migrationPattern.test(name))
    .sort();
  const migrations = await Promise.all(
    names.map(async (filename) => {
      const match = migrationPattern.exec(filename);
      if (!match)
        throw new DurableStorageError(
          "migration",
          `Invalid migration name: ${filename}`,
        );
      const sql = await readFile(path.join(directory, filename), "utf8");
      return {
        version: match[1]!,
        name: match[2]!,
        filename,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(3, "0");
    if (migration.version !== expected) {
      throw new DurableStorageError(
        "migration",
        `Migration sequence must be contiguous: expected ${expected}, found ${migration.version}`,
      );
    }
  });
  return migrations;
}

export async function appliedMigrations(
  sql: DatabaseClient,
): Promise<Map<string, { checksum: string; name: string }>> {
  const exists = await sql<{ exists: boolean }[]>`
    select to_regclass('content_machine.schema_migrations') is not null as exists
  `;
  if (!exists[0]?.exists) return new Map();
  const rows = await sql<
    { version: string; name: string; checksum_sha256: string }[]
  >`
    select version, name, checksum_sha256
    from content_machine.schema_migrations
    order by version
  `;
  return new Map(
    rows.map((row) => [
      row.version,
      { name: row.name, checksum: row.checksum_sha256 },
    ]),
  );
}

export async function migrateDatabase(
  sql: DatabaseClient,
): Promise<{ applied: string[]; current: string }> {
  const migrations = await loadMigrations();
  const applied: string[] = [];
  try {
    await withTransaction(sql, async (transaction) => {
      await transaction`select pg_advisory_xact_lock(${advisoryLockKey})`;
      const existing = await appliedMigrationsInTransaction(transaction);
      for (const migration of migrations) {
        const recorded = existing.get(migration.version);
        if (recorded) {
          if (
            recorded.checksum !== migration.checksum ||
            recorded.name !== migration.name
          ) {
            throw new DurableStorageError(
              "migration",
              `Applied migration ${migration.version} differs from the checked-in file`,
            );
          }
          continue;
        }
        const started = performance.now();
        await transaction.unsafe(migration.sql);
        const elapsed = Math.max(0, Math.round(performance.now() - started));
        await transaction`
          insert into content_machine.schema_migrations
            (version, name, checksum_sha256, execution_ms)
          values (${migration.version}, ${migration.name}, ${migration.checksum}, ${elapsed})
        `;
        applied.push(migration.version);
        existing.set(migration.version, {
          name: migration.name,
          checksum: migration.checksum,
        });
      }
    });
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
  return { applied, current: migrations.at(-1)?.version ?? "000" };
}

async function appliedMigrationsInTransaction(
  transaction: DatabaseTransaction,
): Promise<Map<string, { checksum: string; name: string }>> {
  const exists = await transaction<{ exists: boolean }[]>`
    select to_regclass('content_machine.schema_migrations') is not null as exists
  `;
  if (!exists[0]?.exists) return new Map();
  const rows = await transaction<
    { version: string; name: string; checksum_sha256: string }[]
  >`
    select version, name, checksum_sha256
    from content_machine.schema_migrations
    order by version
  `;
  return new Map(
    rows.map((row) => [
      row.version,
      { name: row.name, checksum: row.checksum_sha256 },
    ]),
  );
}

export async function migrationStatus(sql: DatabaseClient): Promise<{
  current: string;
  expected: string;
  pending: string[];
  valid: boolean;
}> {
  const migrations = await loadMigrations();
  const existing = await appliedMigrations(sql);
  let valid = true;
  for (const migration of migrations) {
    const recorded = existing.get(migration.version);
    if (
      recorded &&
      (recorded.checksum !== migration.checksum ||
        recorded.name !== migration.name)
    )
      valid = false;
  }
  return {
    current: [...existing.keys()].sort().at(-1) ?? "000",
    expected: migrations.at(-1)?.version ?? "000",
    pending: migrations
      .filter((migration) => !existing.has(migration.version))
      .map((migration) => migration.version),
    valid,
  };
}
