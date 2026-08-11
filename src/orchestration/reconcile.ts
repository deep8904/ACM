import { createHash } from "node:crypto";

import type { DatabaseClient } from "../database/client";
import {
  parseApprovedResearchLineage,
  type ApprovedResearchLineageRow,
} from "../research/approved-lineage";
import type { EnqueueAutomationJob } from "./models";
import { researchAutomationInput } from "./research-handoff";
import { PostgresAutomationJobRepository } from "./repository";

type AutomationEnqueuer = Pick<PostgresAutomationJobRepository, "enqueue">;

export async function reconcileAutomationQueue(
  sql: DatabaseClient,
  jobs: AutomationEnqueuer = new PostgresAutomationJobRepository(sql),
  now = new Date(),
) {
  const enqueued: string[] = [];
  const invalidApprovedEvents: string[] = [];
  enqueued.push((await jobs.enqueue(scheduledDiscoveryJob(now))).id);

  const topicEvents = await sql<ApprovedResearchLineageRow[]>`
    select e.id as event_id,e.topic_id as event_topic_id,e.approval_id as event_approval_id,
      e.payload as event_payload,q.id as queue_id,q.topic_id as queue_topic_id,
      q.candidate_id as queue_candidate_id,q.run_id as queue_run_id,
      q.approval_status as queue_approval_status,q.trigger_state as queue_trigger_state,
      q.payload as queue_payload,a.id as approval_id,a.topic_id as approval_topic_id,
      a.action as approval_action,a.status as approval_status,a.payload as approval_payload
    from content_machine.topic_approved_events e
    join content_machine.topic_event_state s on s.event_id=e.id
    join content_machine.topic_queue_items q on q.topic_id=e.topic_id
    join content_machine.topic_approvals a on a.id=e.approval_id and a.topic_id=e.topic_id
    where e.status='ready' and s.consumed_at is null
      and q.approval_status='approved'
      and q.trigger_state='topic_approved_event_created'
      and q.payload->>'researchReadiness'='ready_for_research'
      and a.action='approve' and a.status='approved'
  `;
  for (const row of topicEvents) {
    let event;
    try {
      event = parseApprovedResearchLineage(row).event;
    } catch {
      invalidApprovedEvents.push(row.event_id);
      continue;
    }
    enqueued.push((await jobs.enqueue(researchAutomationInput(event))).id);
  }

  const packets = await sql<{ topic_id: string; packet_version: number }[]>`
    select p.topic_id,p.packet_version
    from content_machine.research_packets p
    where p.payload->>'status'='ready' and (p.payload->>'sufficient')::boolean is true
      and not exists (
        select 1 from content_machine.article_drafts d
        where d.topic_id=p.topic_id and d.research_version=p.packet_version
      )
      and p.packet_version=(select max(p2.packet_version) from content_machine.research_packets p2 where p2.topic_id=p.topic_id)
  `;
  for (const packet of packets) {
    enqueued.push(
      (
        await jobs.enqueue({
          type: "writing",
          idempotencyKey: hash(
            `writing:${packet.topic_id}:${packet.packet_version}`,
          ),
          lineageKey: packet.topic_id,
          topicId: packet.topic_id,
          payload: { researchVersion: packet.packet_version },
        })
      ).id,
    );
  }

  const drafts = await sql<{ topic_id: string; draft_version: number }[]>`
    select d.topic_id,d.draft_version from content_machine.article_drafts d
    where d.payload->>'status'='validated'
      and not exists (
        select 1 from content_machine.editorial_reviews r
        where r.topic_id=d.topic_id and r.draft_version=d.draft_version
      )
      and d.draft_version=(select max(d2.draft_version) from content_machine.article_drafts d2 where d2.topic_id=d.topic_id)
  `;
  for (const draft of drafts) {
    enqueued.push(
      (
        await jobs.enqueue({
          type: "editorial_review",
          idempotencyKey: hash(
            `review:${draft.topic_id}:${draft.draft_version}`,
          ),
          lineageKey: draft.topic_id,
          topicId: draft.topic_id,
          payload: { draftVersion: draft.draft_version },
        })
      ).id,
    );
  }

  const revisions = await sql<
    { topic_id: string; draft_version: number; request_id: string }[]
  >`
    select topic_id,draft_version,request_payload->>'id' as request_id
    from content_machine.revision_tasks
    where request_payload->>'status'='task_ready'
      and resolution_payload is null
  `;
  for (const revision of revisions) {
    enqueued.push(
      (
        await jobs.enqueue({
          type: "revision",
          idempotencyKey: hash(`revision:${revision.request_id}`),
          lineageKey: revision.topic_id,
          topicId: revision.topic_id,
          payload: {
            draftVersion: revision.draft_version,
            requestId: revision.request_id,
          },
        })
      ).id,
    );
  }

  const publications = await sql<{ id: string; topic_id: string }[]>`
    select e.id,e.topic_id from content_machine.final_approved_events e
    where e.status in ('ready_for_publication','scheduled')
      and (e.scheduled_for is null or e.scheduled_for <= ${now.toISOString()})
      and not exists (select 1 from content_machine.publication_consumptions c where c.event_id=e.id)
  `;
  for (const event of publications) {
    enqueued.push(
      (
        await jobs.enqueue({
          type: "publication",
          idempotencyKey: hash(`publication:${event.id}`),
          lineageKey: event.id,
          topicId: event.topic_id,
          payload: { eventId: event.id },
        })
      ).id,
    );
  }
  return {
    enqueued: [...new Set(enqueued)],
    invalidApprovedEvents: [...new Set(invalidApprovedEvents)],
  };
}

export function scheduledDiscoveryJob(now: Date): EnqueueAutomationJob {
  const day = now.toISOString().slice(0, 10);
  return {
    type: "discovery",
    idempotencyKey: hash(`discovery:${day}`),
    lineageKey: `discovery:${day}`,
    payload: {
      runId: `run_${day.replaceAll("-", "")}_scheduled`,
      scheduled: true,
    },
  };
}

export function automationKey(value: string) {
  return hash(value);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
