import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { productionArtifactFixture } from "../publication/__tests__/production-artifact-fixture";
import { publicationRecordSchema } from "../publication/models";
import { createRepositoryComposition } from "./composition";

describe("production publication composition", () => {
  it("keeps fixture lineage out of analytics and exposes only verified artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "production-identity-"));
    const composition = createRepositoryComposition({
      NODE_ENV: "test",
      STORAGE_BACKEND: "file",
      PUBLICATION_STATE_DIRECTORY: join(root, "publication"),
      ANALYTICS_STATE_DIRECTORY: join(root, "analytics"),
    });
    const now = "2026-08-09T20:00:00.000Z",
      hash = "a".repeat(64);
    const fixture = publicationRecordSchema.parse({
      id: "publication_aaaaaaaaaaaaaaaaaaaaaaaa",
      topicId: "topic_production_identity",
      draftId: "draft_bbbbbbbbbbbbbbbbbbbbbbbb",
      draftVersion: 1,
      reviewId: "review_cccccccccccccccccccccccc",
      reviewVersion: 1,
      researchPacketId: "packet_dddddddddddddddddddddddd",
      researchPacketVersion: 1,
      finalApprovedEventId: "articleevent_eeeeeeeeeeeeeeeeeeeeeeee",
      status: "published",
      title: "Fixture lineage",
      slug: "fixture-lineage",
      articlePath: "content/blog/2026/fixture-lineage.mdx",
      repository: "fixture/blog",
      branch: "main",
      commitSha: hash,
      deploymentProvider: "mock",
      canonicalUrl: "https://fixture.example/blog/fixture-lineage",
      publishedAt: now,
      sourceCount: 1,
      contentHash: hash,
      approvedSnapshotHash: hash,
      publishedSnapshotHash: hash,
      createdAt: now,
      updatedAt: now,
      warnings: [],
      provenance: { mode: "fixture", parentSha: hash },
      version: 1,
    });
    await composition.publication.publications.save(fixture);
    expect(await composition.analytics.publications.list()).toEqual([]);
    const production = productionArtifactFixture(fixture, {
      canonicalUrl: "https://production.example/blog/fixture-lineage",
    });
    await composition.publication.productionArtifacts.save(production);
    expect(await composition.analytics.publications.list()).toEqual([
      production,
    ]);
  });
});
