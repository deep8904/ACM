import { describe, expect, it } from "vitest";

import { selectedJobIds, selectedRetryJobIds } from "./cli";

describe("selected production retries", () => {
  it("accepts only unique existing automation-job identities", () => {
    const first = `automationjob_${"a".repeat(24)}`;
    const second = `automationjob_${"b".repeat(24)}`;
    expect(selectedRetryJobIds(`${first}, ${second}`)).toEqual([first, second]);
    expect(() => selectedRetryJobIds(`${first},${first}`)).toThrow(
      "must not contain duplicates",
    );
    expect(() => selectedRetryJobIds("topic_not-a-job")).toThrow(
      "Invalid automation job ID",
    );
  });
  it("validates queued job selections without treating them as retries", () => {
    const id = `automationjob_${"c".repeat(24)}`;
    expect(selectedJobIds(id, "SELECTED_JOB_IDS")).toEqual([id]);
    expect(() => selectedJobIds(undefined, "SELECTED_JOB_IDS")).toThrow(
      "SELECTED_JOB_IDS is required",
    );
  });
});
