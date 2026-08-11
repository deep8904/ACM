import {
  topicApprovalSchema,
  topicQueueItemSchema,
  type TopicApproval,
  type TopicApprovedEvent,
  type TopicQueueItem,
} from "../telegram/models";
import { parseDurableApprovedEvent } from "./approved-event";

export interface ApprovedResearchLineageRow {
  event_id: string;
  event_topic_id: string;
  event_approval_id: string;
  event_payload: unknown;
  queue_id: string;
  queue_topic_id: string;
  queue_candidate_id: string;
  queue_run_id: string;
  queue_approval_status: string;
  queue_trigger_state: string;
  queue_payload: unknown;
  approval_id: string;
  approval_topic_id: string;
  approval_action: string;
  approval_status: string;
  approval_payload: unknown;
}

export interface ApprovedResearchLineage {
  event: TopicApprovedEvent;
  queue: TopicQueueItem;
  approval: TopicApproval;
}

export function parseApprovedResearchLineage(
  row: ApprovedResearchLineageRow,
): ApprovedResearchLineage {
  const event = parseDurableApprovedEvent({
    id: row.event_id,
    topicId: row.event_topic_id,
    payload: row.event_payload,
  });
  const queue = topicQueueItemSchema.parse(row.queue_payload);
  const approval = topicApprovalSchema.parse(row.approval_payload);

  const validColumns =
    row.event_approval_id === row.approval_id &&
    queue.id === row.queue_id &&
    queue.topicId === row.queue_topic_id &&
    queue.candidateId === row.queue_candidate_id &&
    queue.runId === row.queue_run_id &&
    queue.approvalStatus === row.queue_approval_status &&
    queue.triggerState === row.queue_trigger_state &&
    approval.id === row.approval_id &&
    approval.topicId === row.approval_topic_id &&
    approval.action === row.approval_action &&
    approval.status === row.approval_status;
  const validLineage =
    queue.topicId === event.topicId &&
    queue.candidateId === event.candidateId &&
    queue.runId === event.runId &&
    approval.topicId === event.topicId &&
    approval.candidateId === event.candidateId &&
    approval.runId === event.runId &&
    approval.userId === event.approvedBy.telegramUserId &&
    approval.chatId === event.approvedBy.telegramChatId;
  const ready =
    event.status === "ready" &&
    queue.approvalStatus === "approved" &&
    queue.researchReadiness === "ready_for_research" &&
    queue.triggerState === "topic_approved_event_created" &&
    approval.action === "approve" &&
    approval.status === "approved";

  if (!validColumns || !validLineage || !ready)
    throw new Error(
      `Invalid approved research lineage for ${row.event_id}: canonical event, queue, and approval records must agree`,
    );

  return { event, queue, approval };
}
