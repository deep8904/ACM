import { describe, expect, it } from "vitest";
import {
  normalizeRevisionIdentity,
  revisionIssueIdsForDecision,
} from "./worker";

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

  it("copies immutable revision identity from the prepared task", () => {
    const normalized = normalizeRevisionIdentity(
      {
        schemaVersion: "1.0",
        topicId: "wrong_topic",
        sourceDraftId: "draft_bbbbbbbbbbbbbbbbbbbbbbbb",
        sourceDraftVersion: 99,
        revisionScope: "title_only",
        addressedIssueIds: [],
        title: "A sufficiently descriptive revised article title",
        alternateTitles: [
          "A sufficiently descriptive alternate article title",
          "Another sufficiently descriptive alternate article title",
        ],
        description:
          "A sufficiently descriptive revised article summary that remains within the required length constraints.",
        slug: "revised-article-title",
        mdx: "## Revised section\n\nRevised body.",
        claimReferences: [],
        sourceIdsUsed: [],
        changeSummary: "Applied the requested bounded changes.",
        writerNotes: [],
        unresolvedIssues: [],
        provenance: {
          mode: "manual_claude_code",
          taskHash: "b".repeat(64),
        },
      },
      {
        topicId: "topic_fixture",
        sourceDraftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
        sourceDraftVersion: 1,
        request: { scope: "full_revision" },
      },
      "a".repeat(64),
    );

    expect(normalized).toMatchObject({
      topicId: "topic_fixture",
      sourceDraftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      sourceDraftVersion: 1,
      revisionScope: "full_revision",
      provenance: {
        mode: "manual_claude_code",
        taskHash: "a".repeat(64),
      },
    });
  });
});
