import { describe, expect, it } from "vitest";

import { createLogRecord } from "./logger";

describe("createLogRecord", () => {
  it("creates a structured event with pipeline identifiers", () => {
    const record = createLogRecord(
      "info",
      "Topic is waiting for approval",
      {
        runId: "run_20260806_sample",
        stage: "AWAITING_TOPIC_APPROVAL",
        topicId: "topic_sample",
        attempt: 1,
      },
      new Date("2026-08-06T12:00:00.000Z"),
    );

    expect(record).toEqual({
      timestamp: "2026-08-06T12:00:00.000Z",
      level: "info",
      message: "Topic is waiting for approval",
      runId: "run_20260806_sample",
      stage: "AWAITING_TOPIC_APPROVAL",
      topicId: "topic_sample",
      attempt: 1,
    });
  });
});
