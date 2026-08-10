import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicationConfigSchema } from "../config";
import { FileEventConsumerRepository } from "../storage";
import { consumptionRecordSchema } from "../models";
describe("publication state", () => {
  it("fails closed on unsafe configuration", () => {
    const base = {
      mode: "github",
      repository: "owner/repo",
      defaultBranch: "main",
      branchStrategy: "publication_branch",
      contentRoot: "content/blog",
      pathPattern: "content/blog/{year}/{slug}.mdx",
      siteOrigin: "http://example.com",
      blogRoutePrefix: "/blog",
      citationStyle: "numbered_footnotes",
      commitMessagePattern: "publish: {title}",
      deploymentProvider: "manual",
      deploymentPolicy: "manual",
      deploymentTimeoutSeconds: 10,
      pollIntervalSeconds: 10,
      publicPageVerification: false,
      maximumAttempts: 3,
      scheduledGraceMinutes: 60,
      claimTimeoutMinutes: 30,
      notifications: true,
    };
    expect(() => publicationConfigSchema.parse(base)).toThrow();
    expect(() =>
      publicationConfigSchema.parse({
        ...base,
        siteOrigin: "https://example.com",
        pollIntervalSeconds: 1,
        contentRoot: "../private",
      }),
    ).toThrow();
  });
  it("consumes an event once without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "publication-state-"));
    const repo = new FileEventConsumerRepository(root);
    const record = consumptionRecordSchema.parse({
      finalApprovedEventId: "articleevent_aaaaaaaaaaaaaaaaaaaaaaaa",
      consumerId: "worker",
      publicationId: "publication_bbbbbbbbbbbbbbbbbbbbbbbb",
      commitSha: "c".repeat(64),
      verificationState: "verified",
      consumedAt: "2026-08-06T12:00:00.000Z",
      snapshotHash: "d".repeat(64),
    });
    expect(await repo.consume(record)).toBe(true);
    expect(await repo.consume(record)).toBe(false);
    expect(await repo.get(record.finalApprovedEventId)).toEqual(record);
  });
});
