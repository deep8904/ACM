import { describe, expect, it } from "vitest";
import type { ResearchPacket } from "../../research/models";
import type { ArticleDraft, DraftQualityReport } from "../../writing/models";
import { reviewConfigSchema } from "../config";
import {
  classifyEditorialRisk,
  runDeterministicEditorialReview,
} from "../deterministic";

const config = reviewConfigSchema.parse({});
const baseDraft = {
  id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
  topicId: "topic",
  version: 1,
  title: "Widget Offline Mode Changes Developer Workflows",
  description:
    "Widget offline mode changes developer workflows while leaving important collaboration limits in place.",
  heroAlt: "Diagram of a local editor beside a disconnected cloud",
  articleType: "news_analysis",
  claimReferences: [],
  mdx: "Widget offline mode addresses work during unreliable connections. This source-based analysis does not claim hands-on testing.\n\n## Event\n\nWidget added offline mode. [source:source_aaaaaaaaaaaaaaaaaaaaaaaa]\n\n## Context\n\nThe event changes local work.\n\n## Meaning\n\nThe supplied evidence supports local continuity.\n\n## Impact by audience\n\nDevelopers may benefit.\n\n## Counterpoints\n\nCollaboration still needs a connection.\n\n## Outlook\n\nThe practical answer is resilience, not full independence.",
  plainText:
    "Widget offline mode addresses work during unreliable connections. Widget added offline mode. Collaboration still needs a connection. The practical answer is resilience, not full independence.",
} as unknown as ArticleDraft;
const quality = {
  status: "passed",
  blockingIssues: [],
  citationCoverage: { score: 100 },
  createdAt: "2026-08-06T12:00:00.000Z",
} as unknown as DraftQualityReport;
const packet = {
  sourceIndex: [
    {
      id: "source_aaaaaaaaaaaaaaaaaaaaaaaa",
      isPrimary: true,
      selectedExcerpts: [{ text: "Widget added offline mode." }],
    },
  ],
  facts: [],
  interpretations: [],
  predictions: [],
  communityObservations: [],
  conflicts: [],
  counterpoints: ["Collaboration still needs a connection."],
  unknowns: [],
} as unknown as ResearchPacket;

describe("deterministic editorial review", () => {
  it("flags fake hands-on language as a critical blocker", () => {
    const report = runDeterministicEditorialReview(
      { ...baseDraft, mdx: `${baseDraft.mdx}\n\nI tested the product myself.` },
      quality,
      packet,
      config,
      "2026-08-06T12:00:00.000Z",
    );
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "first_hand_claim",
          severity: "critical",
          blocking: true,
        }),
      ]),
    );
  });
  it("flags unsupported certainty and relative time", () => {
    const report = runDeterministicEditorialReview(
      {
        ...baseDraft,
        mdx: `${baseDraft.mdx}\n\nToday this always guarantees success.`,
        claimReferences: [
          {
            id: "draftclaim_aaaaaaaaaaaaaaaaaaaaaaaa",
            statement: "This always guarantees success.",
            sourceIds: ["source_aaaaaaaaaaaaaaaaaaaaaaaa"],
            researchClaimIds: [],
            claimType: "fact",
          },
        ],
      } as unknown as ArticleDraft,
      quality,
      packet,
      config,
      "2026-08-06T12:00:00.000Z",
    );
    expect(report.issues.map((x) => x.category)).toContain("factual_support");
  });
  it("classifies critical factual risk explainably", () => {
    expect(
      classifyEditorialRisk([
        {
          category: "factual_support",
          severity: "critical",
          title: "Fabricated",
          status: "open",
        } as never,
      ]),
    ).toMatchObject({ factual: "critical", overall: "critical" });
  });
});
