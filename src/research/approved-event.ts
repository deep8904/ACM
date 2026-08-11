import {
  topicApprovedEventSchema,
  type TopicApprovedEvent,
} from "../telegram/models";

export class DurableApprovedEventError extends Error {
  readonly code = "durable_approved_event_invalid";

  constructor(message: string) {
    super(message);
    this.name = "DurableApprovedEventError";
  }
}

export function parseDurableApprovedEvent(row: {
  id: string;
  topicId: string;
  payload: unknown;
}): TopicApprovedEvent {
  const parsed = topicApprovedEventSchema.safeParse(row.payload);
  if (!parsed.success) {
    throw new DurableApprovedEventError(
      `Invalid durable approved-topic event ${row.id}: ${parsed.error.issues
        .slice(0, 3)
        .map(
          (issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }
  if (parsed.data.id !== row.id || parsed.data.topicId !== row.topicId) {
    throw new DurableApprovedEventError(
      `Invalid durable approved-topic event ${row.id}: row identity does not match its canonical payload`,
    );
  }
  return parsed.data;
}
