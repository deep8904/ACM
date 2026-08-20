import { createHash } from "node:crypto";

import type { DatabaseClient } from "../database/client";

export interface WritingPreparationAudit {
  eventType: "writing_evidence_compressed";
  preparationVersion: string;
  inputHash: string;
  outputHash: string;
  rawCharacters: number;
  preparedCharacters: number;
  sourceCount: number;
  claimCount: number;
  excerptCount: number;
  requiredFactCount: number;
}

export function writingPreparationAudit(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as { preparationAudit?: unknown }).preparationAudit;
  if (!candidate || typeof candidate !== "object") return undefined;
  const audit = candidate as Partial<WritingPreparationAudit>;
  if (
    audit.eventType !== "writing_evidence_compressed" ||
    typeof audit.preparationVersion !== "string" ||
    !hash(audit.inputHash) ||
    !hash(audit.outputHash) ||
    !nonnegative(audit.rawCharacters) ||
    !nonnegative(audit.preparedCharacters) ||
    !nonnegative(audit.sourceCount) ||
    !nonnegative(audit.claimCount) ||
    !nonnegative(audit.excerptCount) ||
    !nonnegative(audit.requiredFactCount)
  )
    throw new Error("Writing preparation audit metadata is invalid");
  return audit as WritingPreparationAudit;
}

export async function recordWritingPreparationAudit(
  sql: DatabaseClient,
  jobId: string,
  audit: WritingPreparationAudit,
) {
  const id = `pipelineaudit_${sha256(`${jobId}:${audit.eventType}:${audit.outputHash}`).slice(0, 24)}`;
  const details = {
    preparationVersion: audit.preparationVersion,
    rawCharacters: audit.rawCharacters,
    preparedCharacters: audit.preparedCharacters,
    sourceCount: audit.sourceCount,
    claimCount: audit.claimCount,
    excerptCount: audit.excerptCount,
    requiredFactCount: audit.requiredFactCount,
  };
  await sql`
    insert into content_machine.pipeline_audit_events
      (id,job_id,stage,event_type,input_hash,output_hash,details)
    values (${id},${jobId},'writing',${audit.eventType},${audit.inputHash},${audit.outputHash},${sql.json(details)})
    on conflict (job_id,event_type,output_hash) do nothing
  `;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
