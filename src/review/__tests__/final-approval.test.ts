import { describe, expect, it } from "vitest";
import { normalizeSchedule } from "../final-approval";
import {
  assertFinalApprovalEligibility,
  assertReviewEligibility,
} from "../eligibility";

describe("review and final eligibility", () => {
  const valid = {
    draft: {
      id: "draft",
      version: 1,
      status: "validated",
      draft: true,
      publishedAt: null,
      canonicalUrl: null,
      heroImage: null,
      researchContentHashes: ["a"],
    },
    quality: { status: "passed", citationCoverage: { score: 90 } },
    packet: {
      status: "ready",
      sufficient: true,
      blockingReasons: [],
      contentHashes: ["a"],
    },
  };
  it("accepts an exact validated review input", () => {
    expect(() =>
      assertReviewEligibility({
        ...valid,
        selectedVersion: 1,
        latestDraftVersion: 1,
        topicActive: true,
        activeJob: false,
      } as unknown as Parameters<typeof assertReviewEligibility>[0]),
    ).not.toThrow();
  });
  it("rejects an implicit, superseded, or active review input", () => {
    expect(() =>
      assertReviewEligibility({
        ...valid,
        selectedVersion: 1,
        latestDraftVersion: 2,
        topicActive: true,
        activeJob: true,
      } as unknown as Parameters<typeof assertReviewEligibility>[0]),
    ).toThrow(/active review job|newer draft/);
  });
  it("rejects final approval for a locally normalized revise", () => {
    expect(() =>
      assertFinalApprovalEligibility({
        ...valid,
        latestDraftVersion: 1,
        topicActive: true,
        minimumCitationCoverage: 85,
        pendingRevision: false,
        review: {
          decision: "revise",
          issues: [],
          riskSummary: { overall: "low" },
        } as never,
      } as unknown as Parameters<typeof assertFinalApprovalEligibility>[0]),
    ).toThrow(/not eligible/);
  });
  it("rejects a critical open issue", () => {
    expect(() =>
      assertFinalApprovalEligibility({
        ...valid,
        latestDraftVersion: 1,
        topicActive: true,
        minimumCitationCoverage: 85,
        pendingRevision: false,
        review: {
          decision: "pass",
          issues: [{ status: "open", severity: "critical", blocking: true }],
          riskSummary: { overall: "critical" },
        } as never,
      } as unknown as Parameters<typeof assertFinalApprovalEligibility>[0]),
    ).toThrow(/blocking editorial|critical editorial/);
  });
});

describe("Phoenix scheduling", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  it("normalizes a Phoenix local time to UTC", () => {
    expect(normalizeSchedule("2026-08-07T09:30", now, 180)).toEqual({
      at: "2026-08-07T16:30:00.000Z",
      timezone: "America/Phoenix",
    });
  });
  it("preserves explicit offset semantics", () => {
    expect(
      normalizeSchedule("2026-08-07T09:30:00-04:00", now, 180).timezone,
    ).toBe("explicit-offset");
  });
  it("rejects past and impossible times", () => {
    expect(() => normalizeSchedule("2026-08-01T09:30", now, 180)).toThrow(
      /future/,
    );
    expect(() => normalizeSchedule("not-a-date", now, 180)).toThrow(/Invalid/);
  });
});
