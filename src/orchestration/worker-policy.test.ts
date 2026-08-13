import { describe, expect, it } from "vitest";
import { revisionIssueIdsForDecision } from "./worker";

describe("automation worker editorial policy", () => {
  it.each(["revise", "block"] as const)(
    "queues actionable revisions for a %s decision",
    (decision) => {
      expect(
        revisionIssueIdsForDecision(decision, [
          { id: "issue_open", status: "open" },
          { id: "issue_resolved", status: "resolved" },
        ]),
      ).toEqual(["issue_open"]);
    },
  );

  it("does not revise a passing review", () => {
    expect(
      revisionIssueIdsForDecision("pass", [
        { id: "issue_open", status: "open" },
      ]),
    ).toEqual([]);
  });
});
