import { afterAll, describe, expect } from "vitest";

import { PostgresTopicApprovalRepository } from "../../telegram/postgres-repository";
import type { DatabaseClient } from "../client";
import {
  closeDatabaseClient,
  postgresTest,
  suffix,
  testClient,
} from "./helpers";

let sql: DatabaseClient | undefined;
afterAll(async () => {
  if (sql) await closeDatabaseClient(sql);
});

describe("Postgres concurrency", () => {
  postgresTest(
    "creates exactly one durable effect for duplicate Telegram delivery",
    async () => {
      sql = await testClient();
      const repository = new PostgresTopicApprovalRepository(sql);
      const numeric = Number(`8${suffix().replace(/\D/g, "").slice(-8)}`);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.claimUpdate(
            numeric,
            `callback_${suffix()}`,
            new Date().toISOString(),
          ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repository.hasProcessedUpdate(numeric)).toBe(true);
    },
  );
});
