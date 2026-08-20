import { describe, expect, it } from "vitest";

import { CRITICAL_TABLES } from "../health";
import { loadMigrations } from "../migrations";

describe("database migrations", () => {
  it("are contiguous, private, and cover every critical table", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((item) => item.version)).toEqual([
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
      "010",
      "011",
      "012",
      "013",
      "014",
      "015",
      "016",
      "017",
      "018",
      "019",
      "020",
      "021",
      "022",
      "023",
      "024",
      "025",
      "026",
      "027",
    ]);
    const sql = migrations.map((item) => item.sql).join("\n");
    expect(sql).toContain("create schema if not exists content_machine");
    expect(sql).toContain("revoke all on schema content_machine from public");
    for (const table of CRITICAL_TABLES)
      expect(sql).toContain(`content_machine.${table}`);
  });
  it("keys stable research packet IDs by immutable version", async () => {
    const migration = (await loadMigrations()).find(
      (item) => item.version === "012",
    );
    expect(migration?.sql).toContain("primary key (id, packet_version)");
    expect(migration?.sql).not.toMatch(
      /delete\s+from\s+content_machine\.research_packets/i,
    );
    expect(migration?.sql).not.toMatch(
      /update\s+content_machine\.research_packets/i,
    );
  });
  it("keys stable research source IDs by retrieved content version", async () => {
    const migration = (await loadMigrations()).find(
      (item) => item.version === "013",
    );
    expect(migration?.sql).toContain("primary key (id, content_hash)");
    expect(migration?.sql).not.toMatch(
      /delete\s+from\s+content_machine\.research_sources/i,
    );
    expect(migration?.sql).not.toMatch(
      /update\s+content_machine\.research_sources/i,
    );
  });
  it("uses immutable guards for versioned content", async () => {
    const sql = (await loadMigrations()).map((item) => item.sql).join("\n");
    for (const table of [
      "research_packets",
      "article_drafts",
      "editorial_reviews",
      "social_packages",
      "performance_snapshots",
      "editorial_reports",
      "publication_republishes",
      "production_publication_artifacts",
      "social_distribution_events",
      "social_assets",
      "research_source_evidence_records",
    ])
      expect(sql).toContain(`${table}_immutable`);
  });
  it("repairs only malformed seeded interests and their failed discovery run", async () => {
    const migration = (await loadMigrations()).find(
      (item) => item.version === "023",
    );
    expect(migration?.sql).toContain("content_machine.editorial_interests");
    expect(migration?.sql).toContain("at time zone 'UTC'");
    expect(migration?.sql).toContain("job_type='discovery'");
    expect(migration?.sql).toContain(
      "failure_summary like '%Invalid ISO datetime%'",
    );
    expect(migration?.sql).not.toMatch(/delete\s+from/i);
  });
  it("repairs malformed topic queue timestamps without deleting history", async () => {
    const migration = (await loadMigrations()).find(
      (item) => item.version === "025",
    );
    expect(migration?.sql).toContain("content_machine.topic_queue_items");
    expect(migration?.sql).toContain("at time zone 'UTC'");
    expect(migration?.sql).toContain("payload->>'updatedAt'");
    expect(migration?.sql).not.toMatch(/delete\s+from/i);
  });
  it("keys immutable article drafts and quality reports by version", async () => {
    const migration = (await loadMigrations()).find(
      (item) => item.version === "026",
    );
    expect(migration?.sql).toContain(
      "article_drafts_pkey primary key (id, draft_version)",
    );
    expect(migration?.sql).toContain(
      "draft_quality_reports_pkey primary key (draft_id, draft_version)",
    );
    expect(migration?.sql).toContain("foreign key (draft_id, draft_version)");
    expect(migration?.sql).not.toMatch(/delete\s+from/i);
    expect(migration?.sql).not.toMatch(/update\s+content_machine/i);
  });
});
