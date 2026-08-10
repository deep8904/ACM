import { afterAll, describe, expect } from "vitest";

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

describe("Postgres recovery invariants", () => {
  postgresTest(
    "keeps an immutable packet visible when consumption is interrupted",
    async () => {
      sql = await testClient();
      const key = suffix();
      const eventId = `event_${key}`;
      await sql`insert into content_machine.topic_approved_events(id,topic_id,status,version,payload,approved_at) values (${eventId},${`topic_${key}`},'ready',1,${sql.json({ id: eventId })},now())`;
      await sql`insert into content_machine.topic_event_state(event_id) values (${eventId})`;
      await sql`insert into content_machine.research_packets(id,topic_id,approved_event_id,packet_version,content_hash,payload) values (${`packet_${key}`},${`topic_${key}`},${eventId},1,${"a".repeat(64)},${sql.json({ id: `packet_${key}` })})`;
      const rows = await sql<
        { consumed: boolean }[]
      >`select consumed_at is not null as consumed from content_machine.topic_event_state where event_id=${eventId}`;
      expect(rows[0]?.consumed).toBe(false);
      const packet = await sql<
        { count: number }[]
      >`select count(*)::int as count from content_machine.research_packets where approved_event_id=${eventId}`;
      expect(packet[0]?.count).toBe(1);
    },
  );
});
