import { createHash } from "node:crypto";

import type { DatabaseClient } from "../database/client";
import { parseDurableApprovedEvent } from "../research/approved-event";
import type { EnqueueAutomationJob } from "./models";
import { researchAutomationInput } from "./research-handoff";
import { PostgresAutomationJobRepository } from "./repository";

export async function reconcileAutomationQueue(
  sql: DatabaseClient,
  jobs = new PostgresAutomationJobRepository(sql),
  now = new Date(),
) {
  const enqueued: string[] = [];
  const invalidApprovedEvents: string[] = [];
  enqueued.push((await jobs.enqueue(scheduledDiscoveryJob(now))).id);

  const topicEvents = await sql<
    { id: string; topic_id: string; payload: unknown }[]
  >`
    select e.id,e.topic_id,e.payload from content_machine.topic_approved_events e
    left join content_machine.topic_event_state s on s.event_id=e.id
    join content_machine.topic_queue_items q on q.topic_id=e.topic_id
    where e.status='ready' and s.consumed_at is null
      and q.approval_status='approved'
      and q.payload->>'researchReadiness'='ready_for_research'
  `;
  for (const row of topicEvents) {
    let event;
    try {
      event = parseDurableApprovedEvent({
        id: row.id,
        topicId: row.topic_id,
        payload: row.payload,
      });
    } catch {
      invalidApprovedEvents.push(row.id);
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
