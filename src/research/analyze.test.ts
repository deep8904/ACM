import { describe, expect, it } from "vitest";

import { analyze } from "./analyze";
import { researchConfigSchema } from "./config";
import { researchSourceSchema } from "./models";

const config = researchConfigSchema.parse({});
const now = "2026-08-11T08:00:00.000Z";

describe("primary-source sufficiency", () => {
  it("does not count a blocked primary URL as retrieved evidence", () => {
    const result = analyze(
      "topic_test",
      [source({ isPrimary: true, authority: "primary", blocked: true })],
      now,
      config,
    );

    expect(result.sufficiency.components.primarySources).toBe(0);
    expect(result.blockingReasons).toContain(
      "No primary source could be retrieved",
    );
  });

  it("distinguishes missing primary metadata from a failed primary retrieval", () => {
    const result = analyze(
      "topic_test",
      [source({ isPrimary: false, authority: "independent" })],
      now,
      config,
    );

    expect(result.blockingReasons).toContain("No primary source was provided");
  });

  it("accepts an extracted primary source for the primary-source component", () => {
    const result = analyze(
      "topic_test",
      [source({ isPrimary: true, authority: "primary" })],
      now,
      config,
    );

    expect(result.sufficiency.components.primarySources).toBe(25);
    expect(result.blockingReasons).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/primary source/i)]),
    );
  });
});

function source(options: {
  isPrimary: boolean;
  authority: "primary" | "independent";
  blocked?: boolean;
}) {
  return researchSourceSchema.parse({
    id: `source_${options.isPrimary ? "a" : "b".repeat(24)}`.padEnd(31, "a"),
    topicId: "topic_test",
    originalUrl: "https://example.com/update",
    canonicalUrl: "https://example.com/update",
    finalUrl: "https://example.com/update",
    title: "Product update",
    publisher: "Example",
    publisherGroup: "example.com",
    sourceType: options.isPrimary
      ? "official_announcement"
      : "technical_reporting",
    authority: options.authority,
    isPrimary: options.isPrimary,
    publishedAt: now,
    retrievedAt: now,
    contentType: options.blocked ? "" : "text/html",
    language: "en",
    contentHash: "a".repeat(64),
    extractionMethod: options.blocked ? "metadata" : "html",
    extractionStatus: options.blocked ? "blocked" : "extracted",
    extractionQuality: options.blocked ? "metadata_only" : "high",
    qualityMetrics: {
      wordCount: options.blocked ? 0 : 100,
      paragraphCount: options.blocked ? 0 : 3,
      headingCount: 1,
      metadataFields: 1,
    },
    wordCount: options.blocked ? 0 : 100,
    summary: "The product is available today.",
    selectedExcerpts: options.blocked
      ? []
      : [
          {
            id: "excerpt_aaaaaaaaaaaaaaaa_1",
            text: "The product is available today.",
            locator: "paragraph 1",
            purpose: "factual support",
          },
        ],
    licenseNotes: "Private research",
    warnings: options.blocked ? ["Retrieval failed: HTTP 403"] : [],
    rawMetadata: {},
  });
}
