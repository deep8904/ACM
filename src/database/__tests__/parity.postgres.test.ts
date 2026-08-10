import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect } from "vitest";

import { FileTelegramRepository } from "../../telegram/file-repository";
import { topicQueueItemSchema } from "../../telegram/models";
import { PostgresTopicApprovalRepository } from "../../telegram/postgres-repository";
import type { ApprovedEventRepository } from "../../research/interfaces";
import { researchPacketSchema } from "../../research/models";
import {
  PostgresAssistedResearchImportRepository,
  PostgresResearchPacketRepository,
  PostgresResearchSourceRepository,
} from "../../research/postgres-repositories";
import {
  FileAssistedResearchImportRepository,
  FileResearchPacketRepository,
  FileResearchSourceRepository,
} from "../../research/storage";
import type { DatabaseClient } from "../client";
import {
  closeDatabaseClient,
  postgresTest,
  suffix,
  testClient,
} from "./helpers";
import {
  researchPacketFixture,
  researchSourceFixture,
  researchVersioningNow,
} from "./research-versioning-fixtures";
import { productionPublicationArtifactSchema } from "../../publication/models";
import { FileProductionPublicationArtifactRepository } from "../../publication/storage";
import { PostgresProductionPublicationArtifactRepository } from "../../publication/postgres-repositories";

let sql: DatabaseClient | undefined;
afterAll(async () => {
  if (sql) await closeDatabaseClient(sql);
});

describe("file/Postgres repository parity", () => {
  postgresTest(
    "matches queue reads, writes, ordering, and version conflicts",
    async () => {
      sql = await testClient();
      const id = suffix()
        .replace(/[^a-z0-9]/g, "")
        .slice(-20)
        .padStart(24, "a");
      const item = topicQueueItemSchema.parse({
        id: `queue_${id}`,
        shortId: id.slice(0, 12),
        topicId: `topic_manual_${id}`,
        candidateId: `manual_${id}`,
        runId: `manual_${id}`,
        candidateSnapshot: {
          kind: "manual_topic",
          candidate: {
            id: `topic_manual_${id}`,
            candidateId: `manual_${id}`,
            runId: `manual_${id}`,
            title: "Durable storage parity topic",
            summary: "",
            recommendedAngle: "",
            score: null,
            selectionReasons: ["manually submitted"],
            evidenceStrength: "unresearched",
            sourceItemIds: [],
            primarySourceItemIds: [],
            submittedAt: "2026-08-07T00:00:00.000Z",
            submittedByUserId: "200",
            submittedInChatId: "100",
          },
        },
        approvalStatus: "pending",
        researchReadiness: "blocked_pending_approval",
        editorialNotes: [],
        requestedAngle: "",
        origin: "manual_topic",
        triggerState: "not_triggered",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
        version: 1,
      });
      const file = new FileTelegramRepository(
        await mkdtemp(join(tmpdir(), "storage-parity-")),
      );
      const postgres = new PostgresTopicApprovalRepository(sql);
      await file.saveQueueItem(item);
      await postgres.saveQueueItem(item);
      expect(await postgres.getQueueItem(item.topicId)).toEqual(
        await file.getQueueItem(item.topicId),
      );
      await expect(
        postgres.saveQueueItem({ ...item, version: 2 }, 99),
      ).rejects.toThrow(/changed/);
      await expect(
        file.saveQueueItem({ ...item, version: 2 }, 99),
      ).rejects.toThrow(/changed/);
    },
  );

  postgresTest(
    "matches immutable research packet versions and assisted-import idempotency",
    async () => {
      sql ??= await testClient();
      const key = suffix()
        .replace(/[^a-f0-9]/g, "")
        .slice(-24)
        .padStart(24, "a");
      const packet = researchPacketFixture(key);
      await sql`
        insert into content_machine.topic_approved_events
          (id,topic_id,status,version,payload,approved_at)
        values (${packet.approvedEventId},${packet.topicId},'ready',1,
          ${sql.json({ id: packet.approvedEventId })},${researchVersioningNow})
      `;
      await sql`
        insert into content_machine.topic_event_state(event_id)
        values (${packet.approvedEventId})
      `;

      let consumed = false;
      const fileEvents: ApprovedEventRepository = {
        next: async () => undefined,
        get: async () => undefined,
        queue: async () => undefined,
        isCancelled: async () => false,
        isConsumed: async () => consumed,
        consume: async () => {
          if (consumed) throw new Error("Event already consumed");
          consumed = true;
        },
      };
      const filePackets = new FileResearchPacketRepository(
        await mkdtemp(join(tmpdir(), "research-packet-parity-")),
      );
      const postgresPackets = new PostgresResearchPacketRepository(sql);
      const fileImports = new FileAssistedResearchImportRepository(
        filePackets,
        fileEvents,
      );
      const postgresImports = new PostgresAssistedResearchImportRepository(sql);
      await filePackets.save(packet);
      await postgresPackets.save(packet);
      const versionOne = structuredClone(packet);
      const versionTwo = researchPacketSchema.parse({
        ...packet,
        version: 2,
        status: "insufficient",
        researchMode: "assisted_import",
        executiveSummary: "No supported evidence was supplied.",
        provenance: {
          deterministic: false,
          importedAt: researchVersioningNow,
          importedBy: "manual",
          promptVersion: packet.provenance.promptVersion,
          sourcePacketVersion: 1,
          importHash: createHash("sha256")
            .update(`${packet.topicId}:first`)
            .digest("hex"),
        },
      });

      const [fileV2, postgresV2] = await Promise.all([
        fileImports.persist(versionTwo, researchVersioningNow),
        postgresImports.persist(versionTwo, researchVersioningNow),
      ]);
      expect(postgresV2).toEqual(fileV2);
      expect(fileV2.version).toBe(2);
      expect(
        await fileImports.persist(versionTwo, researchVersioningNow),
      ).toEqual(fileV2);
      expect(
        await postgresImports.persist(versionTwo, researchVersioningNow),
      ).toEqual(postgresV2);

      const modified = researchPacketSchema.parse({
        ...versionTwo,
        executiveSummary: "The result changed but still has no evidence.",
        provenance: {
          ...versionTwo.provenance,
          importHash: createHash("sha256")
            .update(`${packet.topicId}:modified`)
            .digest("hex"),
        },
      });
      const [fileV3, postgresV3] = await Promise.all([
        fileImports.persist(modified, researchVersioningNow),
        postgresImports.persist(modified, researchVersioningNow),
      ]);
      expect(postgresV3).toEqual(fileV3);
      expect(fileV3.version).toBe(3);
      expect(await filePackets.get(packet.topicId, 1)).toEqual(versionOne);
      expect(await postgresPackets.get(packet.topicId, 1)).toEqual(versionOne);
      expect(await filePackets.get(packet.topicId)).toEqual(fileV3);
      expect(await postgresPackets.get(packet.topicId)).toEqual(postgresV3);
    },
  );

  postgresTest(
    "matches immutable research source content versions",
    async () => {
      sql ??= await testClient();
      const key = createHash("sha256")
        .update(suffix())
        .digest("hex")
        .slice(0, 24);
      const first = researchSourceFixture(key, "a".repeat(64));
      const second = researchSourceFixture(key, "b".repeat(64));
      const file = new FileResearchSourceRepository(
        await mkdtemp(join(tmpdir(), "research-source-parity-")),
      );
      const postgres = new PostgresResearchSourceRepository(sql);

      await file.save(first, "first source body");
      await postgres.save(first, "first source body");
      await file.save(second, "second source body");
      await postgres.save(second, "second source body");

      expect(await postgres.list(first.topicId)).toEqual(
        await file.list(first.topicId),
      );
      expect(await postgres.list(first.topicId)).toHaveLength(2);
    },
  );

  postgresTest(
    "matches immutable production publication artifact persistence",
    async () => {
      sql ??= await testClient();
      const key = createHash("sha256")
        .update(suffix())
        .digest("hex")
        .slice(0, 24);
      const sourceId = `publication_${key}`,
        artifactId = `publication_${createHash("sha256").update(`artifact:${key}`).digest("hex").slice(0, 24)}`,
        eventId = `articleevent_${key}`,
        approvalId = `finalapproval_${key}`,
        republishId = `republish_${key}`,
        now = "2026-08-09T20:00:00.000Z",
        hash = createHash("sha256").update(key).digest("hex");
      await sql`
        insert into content_machine.final_approvals
          (id,short_id,topic_id,draft_version,review_version,status,content_hash,payload,created_at)
        values (${approvalId},${key.slice(0, 12)},${`topic_${key}`},1,1,'approved',${hash},${sql.json({ id: approvalId })},${now})
      `;
      await sql`
        insert into content_machine.final_approved_events
          (id,topic_id,approval_id,draft_version,review_version,status,version,snapshot_hash,payload,created_at)
        values (${eventId},${`topic_${key}`},${approvalId},1,1,'ready_for_publication',1,${hash},${sql.json({ id: eventId })},${now})
      `;
      await sql`
        insert into content_machine.publications
          (id,event_id,topic_id,commit_sha,canonical_url,content_hash,idempotency_key,payload,published_at)
        values (${sourceId},${eventId},${`topic_${key}`},${"a".repeat(40)},${`https://fixture.example/${key}`},${hash},${eventId},${sql.json({ id: sourceId })},${now})
      `;
      await sql`
        insert into content_machine.publication_republishes
          (id,source_publication_id,event_id,repository,base_branch,branch,content_hash,idempotency_key,payload,created_at)
        values (${republishId},${sourceId},${eventId},'owner/blog','main',${`republish/${key}`},${hash},${createHash("sha256").update(`republish:${key}`).digest("hex")},${sql.json({ id: republishId })},${now})
      `;
      const artifact = productionPublicationArtifactSchema.parse({
        id: artifactId,
        sourcePublicationId: sourceId,
        republishId,
        topicId: `topic_${key}`,
        draftId: `draft_${key}`,
        draftVersion: 1,
        reviewId: `review_${key}`,
        reviewVersion: 1,
        researchPacketId: `packet_${key}`,
        researchPacketVersion: 1,
        finalApprovedEventId: eventId,
        status: "published",
        title: "Production artifact parity",
        slug: key,
        articlePath: `content/blog/2026/${key}.mdx`,
        repository: "owner/blog",
        branch: "main",
        baseBranch: "main",
        republishBranch: `republish/${key}`,
        republishCommitSha: "a".repeat(40),
        productionCommitSha: "b".repeat(40),
        republishCommitIsAncestor: true,
        commitSha: "b".repeat(40),
        deploymentProvider: "vercel_git",
        deploymentStatus: "ready",
        deploymentEnvironment: "production",
        deploymentId: `deployment-${key}`,
        deploymentUrl: `https://deployment.example/${key}`,
        canonicalUrl: `https://production.example/${key}`,
        publishedAt: now,
        sourceCount: 1,
        contentHash: hash,
        expectedContentHash: hash,
        approvedSnapshotHash: hash,
        publishedSnapshotHash: hash,
        createdAt: now,
        updatedAt: now,
        verifiedAt: now,
        verificationMethods: [
          "repository_commit",
          "commit_ancestry",
          "production_blob_hash",
          "canonical_frontmatter",
          "production_deployment",
        ],
        idempotencyKey: createHash("sha256")
          .update(`artifact:${key}`)
          .digest("hex"),
        warnings: [],
        provenance: {
          mode: "github_republish_verified",
          sourceMode: "fixture",
          sourcePublicationId: sourceId,
          republishId,
          sourceFinalApprovedEventId: eventId,
          sourceApprovedSnapshotHash: hash,
          sourcePublishedSnapshotHash: hash,
          version: 1,
        },
        version: 1,
      });
      const file = new FileProductionPublicationArtifactRepository(
        await mkdtemp(join(tmpdir(), "production-artifact-parity-")),
      );
      const postgres = new PostgresProductionPublicationArtifactRepository(sql);
      await file.save(artifact);
      await postgres.save(artifact);
      await file.save(artifact);
      await postgres.save(artifact);
      expect(await postgres.getByRepublishId(republishId)).toEqual(
        await file.getByRepublishId(republishId),
      );
      expect(await postgres.list()).toContainEqual(artifact);
    },
  );
});
