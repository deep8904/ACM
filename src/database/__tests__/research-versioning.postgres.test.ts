import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect } from "vitest";

import { writeAtomicJson } from "../../discovery/persistence";
import { importAssistance } from "../../research/assisted";
import type { ResearchPacket } from "../../research/models";
import {
  PostgresAssistedResearchImportRepository,
  PostgresApprovedEventRepository,
  PostgresResearchPacketRepository,
} from "../../research/postgres-repositories";
import type { DatabaseClient } from "../client";
import {
  closeDatabaseClient,
  postgresTest,
  suffix,
  testClient,
} from "./helpers";
import {
  assistedResearchFixture,
  researchPacketFixture,
  researchVersioningNow as now,
} from "./research-versioning-fixtures";

let sql: DatabaseClient | undefined;

afterAll(async () => {
  if (sql) await closeDatabaseClient(sql);
});

describe("Postgres assisted research packet versioning", () => {
  postgresTest(
    "persists immutable v2, reuses an exact duplicate, and permits a modified v3",
    async () => {
      sql ??= await testClient();
      const packet = researchPacketFixture(key());
      await seedWorkflow(sql, packet);
      const packets = new PostgresResearchPacketRepository(sql);
      const events = new PostgresApprovedEventRepository(sql);
      const imports = new PostgresAssistedResearchImportRepository(sql);
      await packets.save(packet);
      const versionOne = await packets.get(packet.topicId, 1);
      const jobBefore = await jobPayload(sql, packet.topicId);
      const resultPath = await writeResult(
        packet,
        "No supported evidence was supplied.",
      );

      const imported = await importAssistance(
        resultPath,
        packets,
        events,
        now,
        imports,
      );
      expect(imported.id).toBe(packet.id);
      expect(imported.version).toBe(2);
      expect(imported.status).toBe("insufficient");
      expect(await packets.get(packet.topicId, 1)).toEqual(versionOne);
      expect(await packets.get(packet.topicId)).toEqual(imported);
      expect(await jobPayload(sql, packet.topicId)).toEqual(jobBefore);

      const duplicate = await importAssistance(
        resultPath,
        packets,
        events,
        now,
        imports,
      );
      expect(duplicate).toEqual(imported);
      expect(await packetCount(sql, packet.topicId)).toBe(2);

      await writeAtomicJson(resultPath, {
        ...assistedResearchFixture(
          packet,
          "No supported evidence was supplied.",
        ),
        executiveSummary:
          "The supplied packet still contains no supported factual evidence.",
      });
      const modified = await importAssistance(
        resultPath,
        packets,
        events,
        now,
        imports,
      );
      expect(modified.id).toBe(packet.id);
      expect(modified.version).toBe(3);
      expect(await packets.get(packet.topicId, 1)).toEqual(versionOne);
      expect(await packets.get(packet.topicId)).toEqual(modified);
      expect(await packetCount(sql, packet.topicId)).toBe(3);
      expect(await consumedVersion(sql, packet.approvedEventId)).toBe(2);
    },
  );

  postgresTest(
    "rolls back packet and provenance when event reconciliation fails",
    async () => {
      sql ??= await testClient();
      const packet = researchPacketFixture(key());
      await seedWorkflow(sql, packet);
      const packets = new PostgresResearchPacketRepository(sql);
      const events = new PostgresApprovedEventRepository(sql);
      const imports = new PostgresAssistedResearchImportRepository(sql);
      await packets.save(packet);
      const versionOne = await packets.get(packet.topicId, 1);
      const jobBefore = await jobPayload(sql, packet.topicId);
      const differentPacket = `packet_${"f".repeat(24)}`;
      await sql`
        update content_machine.topic_event_state
        set consumed_at=${now}, packet_id=${differentPacket}, packet_version=1
        where event_id=${packet.approvedEventId}
      `;
      const stateBefore = await eventState(sql, packet.approvedEventId);
      const resultPath = await writeResult(
        packet,
        "A transaction rollback fixture.",
      );

      await expect(
        importAssistance(resultPath, packets, events, now, imports),
      ).rejects.toThrow(/different research packet/);
      expect(await packetCount(sql, packet.topicId)).toBe(1);
      expect(await packets.get(packet.topicId, 1)).toEqual(versionOne);
      expect(await packets.get(packet.topicId)).toEqual(versionOne);
      expect(await jobPayload(sql, packet.topicId)).toEqual(jobBefore);
      expect(await eventState(sql, packet.approvedEventId)).toEqual(
        stateBefore,
      );
      expect(await importedPacketCount(sql, packet.topicId)).toBe(0);
    },
  );
});

function key() {
  return createHash("sha256").update(suffix()).digest("hex").slice(0, 24);
}

async function seedWorkflow(client: DatabaseClient, packet: ResearchPacket) {
  await client`
    insert into content_machine.topic_approved_events
      (id,topic_id,status,version,payload,approved_at)
    values (${packet.approvedEventId},${packet.topicId},'ready',1,
      ${client.json({ id: packet.approvedEventId })},${now})
  `;
  await client`
    insert into content_machine.topic_event_state(event_id)
    values (${packet.approvedEventId})
  `;
  await client`
    insert into content_machine.research_jobs
      (id,event_id,topic_id,status,worker_id,claimed_at,heartbeat_at,
       attempt_count,version,payload)
    values (${`job_${packet.id.slice("packet_".length)}`},${packet.approvedEventId},
      ${packet.topicId},'awaiting_assistance','test-worker',${now},${now},1,6,
      ${client.json({ status: "awaiting_assistance", version: 6 })})
  `;
}

async function writeResult(packet: ResearchPacket, executiveSummary: string) {
  const root = await mkdtemp(join(tmpdir(), "research-postgres-import-"));
  const path = join(root, "result.json");
  await writeAtomicJson(
    path,
    assistedResearchFixture(packet, executiveSummary),
  );
  return path;
}

async function packetCount(client: DatabaseClient, topicId: string) {
  const rows = await client<{ count: number }[]>`
    select count(*)::int as count
    from content_machine.research_packets where topic_id=${topicId}
  `;
  return rows[0]?.count ?? 0;
}

async function importedPacketCount(client: DatabaseClient, topicId: string) {
  const rows = await client<{ count: number }[]>`
    select count(*)::int as count from content_machine.research_packets
    where topic_id=${topicId} and import_hash is not null
  `;
  return rows[0]?.count ?? 0;
}

async function jobPayload(client: DatabaseClient, topicId: string) {
  const rows = await client<{ payload: unknown }[]>`
    select payload from content_machine.research_jobs where topic_id=${topicId}
  `;
  return rows[0]?.payload;
}

async function eventState(client: DatabaseClient, eventId: string) {
  const rows = await client<
    {
      consumed_at: Date | string | null;
      packet_id: string | null;
      packet_version: number | null;
      version: number;
    }[]
  >`
    select consumed_at,packet_id,packet_version,version
    from content_machine.topic_event_state where event_id=${eventId}
  `;
  return rows[0];
}

async function consumedVersion(client: DatabaseClient, eventId: string) {
  return (await eventState(client, eventId))?.packet_version;
}
