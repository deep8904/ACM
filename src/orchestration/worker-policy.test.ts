import { describe, expect, it } from "vitest";
import {
  normalizeRevisionIdentity,
  revisionIssueIdsForDecision,
} from "./worker";
import { canonicalJsonHash } from "../writing/task";

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

  it("normalizes fenced revision MDX and grounded claim sections", () => {
    const normalized = normalizeRevisionIdentity(
      {
        schemaVersion: "1.0",
        addressedIssueIds: [],
        title: "A sufficiently descriptive revised article title",
        alternateTitles: [
          "A sufficiently descriptive alternate article title",
          "Another sufficiently descriptive alternate article title",
        ],
        description:
          "A sufficiently descriptive revised article summary that remains within the required length constraints.",
        slug: "revised-article-title",
        mdx: "```mdx\n## Evidence [source:source_aaaaaaaaaaaaaaaaaaaaaaaa]\n\nThe verified statement appears here.\n\n## Outlook\n\nUncertainty remains.\n```",
        claimReferences: [
          {
            id: "draftclaim_aaaaaaaaaaaaaaaaaaaaaaaa",
            statement: "The verified statement appears here.",
            claimType: "fact",
            researchClaimIds: ["claim_aaaaaaaaaaaaaaaaaaaaaaaa"],
            sourceIds: ["source_aaaaaaaaaaaaaaaaaaaaaaaa"],
            section: "Evidence [source:source_aaaaaaaaaaaaaaaaaaaaaaaa]",
            supportStatus: "supported",
            notes: [],
          },
        ],
        sourceIdsUsed: ["source_aaaaaaaaaaaaaaaaaaaaaaaa"],
        changeSummary: "Applied the requested bounded changes.",
        writerNotes: [],
        unresolvedIssues: [],
      },
      {
        topicId: "topic_fixture",
        sourceDraftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
        sourceDraftVersion: 1,
        request: { scope: "full_revision" },
      },
      "a".repeat(64),
    );

    expect(normalized.mdx).toContain(
      "## Evidence\n\n[source:source_aaaaaaaaaaaaaaaaaaaaaaaa]",
    );
    expect(normalized.mdx).not.toContain("```mdx");
    expect(normalized.claimReferences[0]?.section).toBe("Evidence");
  });

  it("hashes semantically identical task objects independent of key order", () => {
    expect(canonicalJsonHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJsonHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});
