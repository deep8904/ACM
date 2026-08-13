import { describe, expect, it } from "vitest";
import type { ResearchPacket } from "../../research/models";
import type { ArticleDraft, DraftQualityReport } from "../../writing/models";
import { reviewConfigSchema } from "../config";
import type { DeterministicEditorialReport } from "../models";
import { createReviewTask } from "../task";

describe("editorial review task contract", () => {
  it("supplies the exact allowed article section names to the reviewer", async () => {
    const draft = {
      id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      topicId: "topic_fixture",
      version: 1,
      title: "A sufficiently descriptive article title",
      slug: "article-title",
      description:
        "A sufficiently descriptive summary for the editorial review task fixture.",
      category: "Development",
      tags: [],
      heroAlt: "Article illustration",
      articleType: "news_analysis",
      wordCount: 100,
      readingTimeMinutes: 1,
      draft: true,
      publishedAt: null,
      canonicalUrl: null,
      heroImage: null,
      mdx: "Introduction.\n\n## Exact Section\n\nBody.\n\n##### Too Deep\n\nMore body.",
      plainText: "Introduction. Exact Section. Body. Too Deep. More body.",
      claimReferences: [],
    } as unknown as ArticleDraft;
    const packet = {
      id: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
      version: 1,
      contentHashes: ["a".repeat(64)],
      approvedTitle: draft.title,
      approvedAngle: "Explain the evidence",
      executiveSummary: "Summary",
      recommendedThesis: "Thesis",
      counterpoints: [],
      conflicts: [],
      unknowns: [],
      technicalDetails: [],
      productSpecifications: [],
      facts: [],
      interpretations: [],
      predictions: [],
      communityObservations: [],
      sourceIndex: [],
    } as unknown as ResearchPacket;
    const task = await createReviewTask(
      draft,
      {} as DraftQualityReport,
      packet,
      {} as DeterministicEditorialReport,
      reviewConfigSchema.parse({}),
      {
        prompt: "prompts/editorial-review.md",
        audience: "brand/audience.md",
        style: "brand/writing-style.md",
        editorial: "brand/editorial-rules.md",
      },
      "2026-08-13T20:00:00.000Z",
    );

    expect(task.input.allowedArticleSections).toEqual(["Exact Section"]);
    expect(task.files["editorial-review.md"]).toContain(
      "copy its value exactly from allowedArticleSections",
    );
  });
});
