import { describe, expect, it } from "vitest";

import type { DatabaseClient } from "../database/client";
import {
  recordWritingPreparationAudit,
  writingPreparationAudit,
} from "./pipeline-audit";

describe("pipeline preparation audit", () => {
  it("records the compression hashes and evidence counts idempotently", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join("?"), values });
        return Promise.resolve([]);
      },
      { json: (value: unknown) => value },
    ) as unknown as DatabaseClient;
    const audit = writingPreparationAudit({
      preparationAudit: {
        eventType: "writing_evidence_compressed",
        preparationVersion: "2.0",
        inputHash: "a".repeat(64),
        outputHash: "b".repeat(64),
        rawCharacters: 50_000,
        preparedCharacters: 5_000,
        sourceCount: 3,
        claimCount: 8,
        excerptCount: 6,
        requiredFactCount: 4,
      },
    });
    if (!audit) throw new Error("fixture failed");

    await recordWritingPreparationAudit(
      sql,
      `automationjob_${"c".repeat(24)}`,
      audit,
    );

    expect(calls[0]?.text).toContain("pipeline_audit_events");
    expect(calls[0]?.text).toContain("on conflict");
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining([
        "writing_evidence_compressed",
        "a".repeat(64),
        "b".repeat(64),
      ]),
    );
  });
});
