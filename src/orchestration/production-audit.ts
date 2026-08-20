import type { DatabaseClient } from "../database/client";
import type { SourceItem } from "../discovery/models/source-item";
import type { WorkflowArtifactRepository } from "../database/artifacts";

type Json = Record<string, unknown>;
type DateValue = Date | string;

export async function auditProductionResearch(
  sql: DatabaseClient,
  artifacts: WorkflowArtifactRepository,
  input: { eventIds: string[]; jobIds: string[] },
) {
  const eventIds = unique(input.eventIds.map((id) => requiredId(id, "event")));
  const jobIds = unique(
    input.jobIds.map((id) => requiredId(id, "automationjob")),
  );
  const jobs = jobIds.length
    ? await sql<
        {
          id: string;
          job_type: string;
          status: string;
          topic_id: string | null;
          lineage_key: string;
          payload: Json;
          attempt: number;
          maximum_attempts: number;
          failure_code: string | null;
          failure_summary: string | null;
          diagnostic_id: string | null;
          created_at: DateValue;
          updated_at: DateValue;
          started_at: DateValue | null;
          completed_at: DateValue | null;
        }[]
      >`
        select id,job_type,status,topic_id,lineage_key,payload,attempt,maximum_attempts,
          failure_code,failure_summary,diagnostic_id,created_at,updated_at,started_at,completed_at
        from content_machine.automation_jobs where id in ${sql(jobIds)}
        order by created_at,id
      `
    : [];
  for (const job of jobs) {
    const payloadEventId = string(job.payload.eventId);
    if (payloadEventId) eventIds.push(requiredId(payloadEventId, "event"));
    else if (/^event_[a-f0-9]{24}$/.test(job.lineage_key))
      eventIds.push(job.lineage_key);
  }
  const canonicalEventIds = unique(eventIds);
  const events = canonicalEventIds.length
    ? await sql<
        {
          id: string;
          topic_id: string;
          approval_id: string | null;
          status: string;
          version: number;
          payload: Json;
          approved_at: DateValue;
          created_at: DateValue;
        }[]
      >`
        select id,topic_id,approval_id,status,version,payload,approved_at,created_at
        from content_machine.topic_approved_events where id in ${sql(canonicalEventIds)}
        order by created_at,id
      `
    : [];
  const topicIds = unique([
    ...events.map((row) => row.topic_id),
    ...jobs.map((row) => row.topic_id).filter(isString),
  ]);
  const topicAutomationJobs = topicIds.length
    ? await sql<
        {
          id: string;
          job_type: string;
          status: string;
          topic_id: string | null;
          parent_job_id: string | null;
          lineage_key: string;
          payload: Json;
          failure_summary: string | null;
          diagnostic_id: string | null;
          created_at: DateValue;
          updated_at: DateValue;
        }[]
      >`
        select id,job_type,status,topic_id,parent_job_id,lineage_key,payload,
          failure_summary,diagnostic_id,created_at,updated_at
        from content_machine.automation_jobs where topic_id in ${sql(topicIds)}
        order by created_at,id
      `
    : [];
  const queues = topicIds.length
    ? await sql<
        {
          id: string;
          topic_id: string;
          candidate_id: string;
          run_id: string;
          approval_status: string;
          trigger_state: string;
          version: number;
          payload: Json;
          created_at: DateValue;
          updated_at: DateValue;
        }[]
      >`
        select id,topic_id,candidate_id,run_id,approval_status,trigger_state,version,
          payload,created_at,updated_at from content_machine.topic_queue_items
        where topic_id in ${sql(topicIds)} order by created_at,id
      `
    : [];
  const approvals = topicIds.length
    ? await sql<
        {
          id: string;
          topic_id: string;
          queue_item_id: string | null;
          action: string;
          status: string;
          version: number;
          created_at: DateValue;
          updated_at: DateValue;
        }[]
      >`
        select id,topic_id,queue_item_id,action,status,version,created_at,updated_at
        from content_machine.topic_approvals where topic_id in ${sql(topicIds)}
        order by created_at,id
      `
    : [];
  const eventState = canonicalEventIds.length
    ? await sql<
        {
          event_id: string;
          attempt_count: number;
          consumed_at: DateValue | null;
          packet_id: string | null;
          packet_version: number | null;
          version: number;
        }[]
      >`
        select event_id,attempt_count,consumed_at,packet_id,packet_version,version
        from content_machine.topic_event_state where event_id in ${sql(canonicalEventIds)}
        order by event_id
      `
    : [];
  const researchJobs = canonicalEventIds.length
    ? await sql<
        {
          id: string;
          event_id: string;
          topic_id: string;
          status: string;
          attempt_count: number;
          version: number;
          payload: Json;
          created_at: DateValue;
          updated_at: DateValue;
        }[]
      >`
        select id,event_id,topic_id,status,attempt_count,version,payload,created_at,updated_at
        from content_machine.research_jobs where event_id in ${sql(canonicalEventIds)}
        order by created_at,id
      `
    : [];
  const packets = topicIds.length
    ? await sql<
        {
          id: string;
          topic_id: string;
          approved_event_id: string;
          packet_version: number;
          content_hash: string;
          payload: Json;
          created_at: DateValue;
        }[]
      >`
        select id,topic_id,approved_event_id,packet_version,content_hash,payload,created_at
        from content_machine.research_packets where topic_id in ${sql(topicIds)}
        order by topic_id,packet_version
      `
    : [];
  const sources = topicIds.length
    ? await sql<
        {
          id: string;
          topic_id: string;
          canonical_url: string;
          content_hash: string;
          byte_length: number;
          payload: Json;
          retrieved_at: DateValue;
        }[]
      >`
        select id,topic_id,canonical_url,content_hash,byte_length,payload,retrieved_at
        from content_machine.research_sources where topic_id in ${sql(topicIds)}
        order by topic_id,retrieved_at,id
      `
    : [];
  const drafts = topicIds.length
    ? await sql<
        {
          id: string;
          topic_id: string;
          draft_version: number;
          research_version: number;
          payload: Json;
          created_at: DateValue;
        }[]
      >`
        select id,topic_id,draft_version,research_version,payload,created_at
        from content_machine.article_drafts where topic_id in ${sql(topicIds)}
        order by topic_id,draft_version
      `
    : [];
  const editorialReviews = topicIds.length
    ? await sql<
        {
          id: string;
          topic_id: string;
          draft_version: number;
          review_version: number;
          payload: Json;
          created_at: DateValue;
        }[]
      >`
        select id,topic_id,draft_version,review_version,payload,created_at
        from content_machine.editorial_reviews where topic_id in ${sql(topicIds)}
        order by topic_id,draft_version,review_version
      `
    : [];
  const finalApprovals = topicIds.length
    ? await sql<
        {
          id: string;
          short_id: string;
          topic_id: string;
          draft_version: number;
          review_version: number;
          status: string;
          content_hash: string;
          payload: Json;
          created_at: DateValue;
        }[]
      >`
        select id,short_id,topic_id,draft_version,review_version,status,content_hash,payload,created_at
        from content_machine.final_approvals where topic_id in ${sql(topicIds)}
        order by topic_id,draft_version,review_version
      `
    : [];
  const invocations = jobIds.length
    ? await sql<
        {
          id: string;
          job_id: string;
          stage: string;
          provider: string;
          model: string;
          provider_version: string | null;
          status: string;
          error_summary: string | null;
          attempt_index: number;
          fallback_used: boolean;
          fallback_reason: string | null;
          failure_reason: string | null;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          total_tokens: number | null;
          created_at: DateValue;
          completed_at: DateValue | null;
        }[]
      >`
        select id,job_id,stage,provider,model,provider_version,status,error_summary,
          attempt_index,fallback_used,fallback_reason,failure_reason,
          prompt_tokens,completion_tokens,total_tokens,created_at,completed_at
        from content_machine.llm_invocations where job_id in ${sql(jobIds)}
        order by created_at,id
      `
    : [];
  const pipelineAuditEvents = jobIds.length
    ? await sql<
        {
          id: string;
          job_id: string;
          stage: string;
          event_type: string;
          input_hash: string;
          output_hash: string;
          details: Json;
          created_at: DateValue;
        }[]
      >`
        select id,job_id,stage,event_type,input_hash,output_hash,details,created_at
        from content_machine.pipeline_audit_events where job_id in ${sql(jobIds)}
        order by created_at,id
      `
    : [];
  const remediationConversations = jobIds.length
    ? await sql<
        {
          id: string;
          short_id: string;
          topic_id: string;
          event_id: string;
          job_id: string;
          packet_version: number;
          state: string;
          reason: string;
          version: number;
          expires_at: DateValue;
          payload: Json;
          created_at: DateValue;
          updated_at: DateValue;
        }[]
      >`
        select id,short_id,topic_id,event_id,job_id,packet_version,state,reason,
          version,expires_at,payload,created_at,updated_at
        from content_machine.research_remediation_conversations
        where job_id in ${sql(jobIds)} order by created_at,id
      `
    : [];
  const remediationEvents = jobIds.length
    ? await sql<
        {
          id: string;
          remediation_id: string;
          topic_id: string;
          job_id: string;
          action: string;
          diagnostic_id: string | null;
          payload: Json;
          created_at: DateValue;
        }[]
      >`
        select id,remediation_id,topic_id,job_id,action,diagnostic_id,payload,created_at
        from content_machine.research_remediation_events
        where job_id in ${sql(jobIds)} order by created_at,id
      `
    : [];
  const telegramMessages = topicIds.length
    ? await sql<
        {
          short_id: string;
          topic_id: string;
          telegram_message_id: number;
          version: number;
          payload: Json;
          updated_at: DateValue;
        }[]
      >`
        select short_id,topic_id,telegram_message_id,version,payload,updated_at
        from content_machine.telegram_message_index
        where topic_id in ${sql(topicIds)} order by updated_at,short_id
      `
    : [];

  const discoverySources = await discoverySourceAudit(artifacts, events);
  return {
    requested: { eventIds: canonicalEventIds, jobIds },
    events: events.map((row) => ({
      ...without(row, "payload"),
      payloadKeys: Object.keys(row.payload).sort(),
      payload: pick(row.payload, [
        "id",
        "topicId",
        "candidateId",
        "runId",
        "approvedAt",
        "origin",
        "status",
        "sourceItemIds",
        "version",
      ]),
    })),
    queues: queues.map((row) => ({
      ...without(row, "payload"),
      payloadKeys: Object.keys(row.payload).sort(),
      payload: queueSummary(row.payload),
    })),
    approvals,
    eventState,
    automationJobs: jobs.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "eventId",
        "researchVersion",
        "draftVersion",
        "requestId",
        "runId",
        "scheduled",
      ]),
    })),
    topicAutomationJobs: topicAutomationJobs.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "eventId",
        "researchVersion",
        "draftVersion",
        "requestId",
      ]),
    })),
    researchJobs: researchJobs.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "id",
        "eventId",
        "topicId",
        "status",
        "attempt",
        "errors",
        "version",
      ]),
    })),
    packets: packets.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "version",
        "status",
        "sufficient",
        "blockingReasons",
        "warnings",
        "primarySourceIds",
        "provenance",
      ]),
    })),
    researchSources: sources.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "sourceItemId",
        "originalUrl",
        "canonicalUrl",
        "finalUrl",
        "title",
        "publisher",
        "publisherGroup",
        "sourceType",
        "authority",
        "isPrimary",
        "contentType",
        "extractionMethod",
        "extractionStatus",
        "extractionQuality",
        "qualityMetrics",
        "warnings",
        "rawMetadata",
      ]),
    })),
    articleDrafts: drafts.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "status",
        "publishedAt",
        "canonicalUrl",
        "supersedesVersion",
      ]),
    })),
    editorialReviews: editorialReviews.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, ["decision", "summary", "version"]),
    })),
    finalApprovals: finalApprovals.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "status",
        "draftVersion",
        "reviewVersion",
        "expiresAt",
      ]),
    })),
    discoverySources,
    llmInvocations: invocations,
    pipelineAuditEvents,
    remediationConversations: remediationConversations.map((row) => ({
      ...without(row, "payload"),
      payload: pick(row.payload, [
        "pendingUrl",
        "retrievalFailure",
        "diagnosticId",
        "version",
      ]),
    })),
    remediationEvents,
    telegramMessages: telegramMessages.map((row) => ({
      ...without(row, "payload"),
      payloadKeys: Object.keys(row.payload).sort(),
    })),
  };
}

async function discoverySourceAudit(
  artifacts: WorkflowArtifactRepository,
  events: { payload: Json }[],
) {
  const output = [];
  for (const event of events) {
    const runId = string(event.payload.runId);
    const ids = new Set(array(event.payload.sourceItemIds));
    if (!runId || !ids.size) continue;
    const artifact = await artifacts.get(
      runId,
      "discovery",
      "normalized-items.json",
    );
    const items = Array.isArray(artifact?.content)
      ? (artifact.content as SourceItem[])
      : [];
    output.push(
      ...items
        .filter((item) => ids.has(item.id))
        .map((item) => ({
          runId,
          id: item.id,
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          sourceType: item.sourceType,
          authority: item.authority,
          title: item.title,
          url: redactUrl(item.url),
          canonicalUrl: redactUrl(item.canonicalUrl),
          publishedAt: item.publishedAt,
          retrievedAt: item.retrievedAt,
          rawMetadata: pick(item.rawMetadata, [
            "itemId",
            "score",
            "descendants",
            "discussionUrl",
          ]),
        })),
    );
  }
  return output;
}

function queueSummary(payload: Json) {
  const snapshot = object(payload.candidateSnapshot);
  const candidate = object(snapshot?.candidate);
  return {
    ...pick(payload, [
      "id",
      "topicId",
      "candidateId",
      "runId",
      "approvalStatus",
      "researchReadiness",
      "origin",
      "triggerState",
      "createdAt",
      "updatedAt",
      "version",
    ]),
    candidateSnapshot: snapshot
      ? {
          kind: snapshot.kind,
          candidate: candidate
            ? pick(candidate, [
                "id",
                "candidateId",
                "runId",
                "title",
                "submittedUrl",
                "sourceItemIds",
                "primarySourceItemIds",
              ])
            : undefined,
        }
      : undefined,
  };
}

function requiredId(value: string, prefix: "event" | "automationjob") {
  const pattern =
    prefix === "event"
      ? /^event_[a-f0-9]{24}$/
      : /^automationjob_[a-f0-9]{24}$/;
  if (!pattern.test(value)) throw new Error(`Invalid ${prefix} audit ID`);
  return value;
}

function redactUrl(value: string) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()])
    if (/token|key|auth|secret|signature|session/i.test(key))
      url.searchParams.delete(key);
  return url.toString();
}

function pick(value: Json, keys: string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function without<T extends Json, K extends keyof T>(value: T, key: K) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function array(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function unique(values: string[]) {
  return [...new Set(values)];
}
