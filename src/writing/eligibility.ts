import type { ResearchPacket } from "../research/models";
import type { TopicApprovedEvent, TopicQueueItem } from "../telegram/models";

export function assertWritingEligibility(
  packet: ResearchPacket | undefined,
  event: TopicApprovedEvent | undefined,
  queue: TopicQueueItem | undefined,
): asserts packet is ResearchPacket {
  const reasons: string[] = [];
  if (!packet)
    throw new Error(
      "The explicitly requested research packet version does not exist",
    );
  if (packet.status !== "ready")
    reasons.push(`research packet status is ${packet.status}`);
  if (!packet.sufficient) reasons.push("research packet is insufficient");
  if (packet.blockingReasons.length)
    reasons.push(`research blockers: ${packet.blockingReasons.join("; ")}`);
  if (!event || event.id !== packet.approvedEventId || event.status !== "ready")
    reasons.push("topic-approved event is missing, mismatched, or cancelled");
  if (
    !queue ||
    queue.topicId !== packet.topicId ||
    queue.approvalStatus !== "approved" ||
    queue.researchReadiness !== "ready_for_research" ||
    queue.triggerState !== "topic_approved_event_created"
  )
    reasons.push("topic queue is no longer actively approved");
  if (queue && queue.candidateId !== packet.candidateId)
    reasons.push("topic queue candidate no longer matches the research packet");
  if (reasons.length)
    throw new Error(`Writing is not eligible: ${reasons.join("; ")}`);
}
