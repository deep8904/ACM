import { afterAll, describe, expect } from "vitest";

import type { TrendSourceAdapter } from "../../discovery/adapters/types";
import { sourceConfigFileSchema } from "../../discovery/config/source-config";
import { runDiscovery } from "../../discovery/discovery-service";
import { createSourceItem } from "../../discovery/models/source-item";
import { loadRankingConfig } from "../../ranking/config";
import { PostgresHistoryRepository } from "../../ranking/postgres-history";
import { runRankingPipeline } from "../../ranking/service";
import { createPostgresRepositories } from "../../storage/composition";
import type { DatabaseClient } from "../client";
import { checkDatabaseHealth } from "../health";
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

describe("database-backed simulation prerequisites", () => {
  postgresTest("has the complete migrated durable schema", async () => {
    sql = await testClient();
    const health = await checkDatabaseHealth(sql);
    expect(health.healthy).toBe(true);
    expect(health.missingTables).toEqual([]);
  });

  postgresTest(
    "routes discover, rank, research, write, review, publish, social, and analytics through Postgres",
    async () => {
      sql ??= await testClient();
      const repositories = createPostgresRepositories(sql);
      const runId = `run_pg_${suffix().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const retrievedAt = "2026-08-07T20:00:00.000Z";
      const adapter: TrendSourceAdapter = {
        supportedTypes: ["rss"],
        async fetchItems(source) {
          return {
            items: [
              createSourceItem({
                sourceId: source.id,
                sourceName: source.name,
                sourceType: source.type,
                authority: source.authority,
                sourceItemId: `item_${suffix()}`,
                title: "PostgreSQL artifact routing regression",
                url: `https://example.com/${runId}`,
                retrievedAt,
                language: "en",
              }),
            ],
            warnings: [],
          };
        },
      };

      const discovery = await runDiscovery({
        runId,
        config: sourceConfigFileSchema.parse({
          sources: [
            {
              id: "postgres-fixture",
              name: "Postgres fixture",
              type: "rss",
              url: "https://example.com/feed.xml",
              authority: "primary",
              enabled: true,
            },
          ],
        }),
        adapters: [adapter],
        fetch: async () => new Response("not used"),
        artifactRepository: repositories.artifacts,
        now: () => new Date(retrievedAt),
        monotonicNow: () => 100,
        logger: () => undefined,
      });
      expect(discovery.outputDirectory).toMatch(/^database:/);

      const ranking = await runRankingPipeline({
        runId,
        config: await loadRankingConfig(
          "automation/config/ranking.example.yaml",
        ),
        history: new PostgresHistoryRepository(sql),
        artifactRepository: repositories.artifacts,
        now: () => new Date(retrievedAt),
        monotonicNow: () => 100,
        logger: () => undefined,
      });
      expect(ranking.outputDirectory).toMatch(/^database:/);
      expect(ranking.report.inputItemCount).toBe(1);

      const missing = `${runId}_missing`;
      expect(await repositories.research.packets.get(missing)).toBeUndefined();
      expect(await repositories.writing.drafts.get(missing)).toBeUndefined();
      expect(await repositories.review.reviews.get(missing, 1)).toBeUndefined();
      expect(
        await repositories.publication.publications.getByTopic(missing),
      ).toBeUndefined();
      expect(await repositories.social.packages.get(missing)).toBeUndefined();
      expect(await repositories.analytics.articleMetrics.list(missing)).toEqual(
        [],
      );
    },
  );
});
