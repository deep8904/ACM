import { createHash } from "node:crypto";
import { z } from "zod";

import type { ApprovedEventRepository } from "../research/interfaces";
import type { TopicApprovedEvent } from "../telegram/models";
import type { AutomationJob, EnqueueAutomationJob } from "./models";

const eventIdSchema = z.string().regex(/^event_[a-f0-9]{24}$/);

export class InvalidResearchHandoffError extends Error {
  readonly code = "research_handoff_invalid";

  constructor(message: string) {
    super(message);
    this.name = "InvalidResearchHandoffError";
  }
}

export function researchAutomationInput(
  event: TopicApprovedEvent,
): EnqueueAutomationJob {
  return {
    type: "research",
    idempotencyKey: sha256(`research:${event.id}`),
    lineageKey: event.id,
    topicId: event.topicId,
    payload: { eventId: event.id },
  };
}

export async function loadResearchHandoff(
  job: AutomationJob,
  events: ApprovedEventRepository,
): Promise<TopicApprovedEvent> {
  const parsed = z
    .object({
      eventId: eventIdSchema,
      topicId: z.string().min(1),
      lineageKey: eventIdSchema,
    })
    .strict()
    .safeParse({
      eventId: job.payload.eventId,
      topicId: job.topicId,
      lineageKey: job.lineageKey,
    });
  if (!parsed.success) {
    throw new InvalidResearchHandoffError(
      `Invalid research handoff for ${job.id}: canonical event, topic, and lineage identifiers are required`,
    );
  }
  if (parsed.data.eventId !== parsed.data.lineageKey) {
    throw new InvalidResearchHandoffError(
      `Invalid research handoff for ${job.id}: event and lineage identifiers differ`,
    );
  }
  const event = await events.get(parsed.data.eventId);
  if (!event) {
    throw new InvalidResearchHandoffError(
      `Invalid research handoff for ${job.id}: approved event is missing`,
    );
  }
  if (
    event.id !== parsed.data.eventId ||
    event.topicId !== parsed.data.topicId
  ) {
    throw new InvalidResearchHandoffError(
      `Invalid research handoff for ${job.id}: approved event lineage does not match the durable automation job`,
    );
  }
  return event;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
