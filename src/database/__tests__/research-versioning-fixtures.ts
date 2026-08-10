import {
  researchPacketSchema,
  researchSourceSchema,
  type ResearchPacket,
} from "../../research/models";

export const researchVersioningNow = "2026-08-09T12:00:00.000Z";

export function researchPacketFixture(value: string): ResearchPacket {
  const topicId = `topic_manual_${value}`;
  return researchPacketSchema.parse({
    id: `packet_${value}`,
    version: 1,
    topicId,
    candidateId: `manual_${value}`,
    runId: `manual_${value}`,
    approvedEventId: `event_${value}`,
    origin: "manual_topic",
    approvedTitle: "Immutable research packet fixture",
    approvedAngle: "",
    editorialNotes: [],
    createdAt: researchVersioningNow,
    updatedAt: researchVersioningNow,
    status: "awaiting_assisted_synthesis",
    researchMode: "deterministic",
    scope: ["source-backed facts only"],
    executiveSummary: "",
    timeline: [],
    facts: [],
    interpretations: [],
    predictions: [],
    communityObservations: [],
    technicalDetails: [],
    productSpecifications: [],
    counterpoints: [],
    conflicts: [],
    unknowns: ["Supported factual detail is still required"],
    sourceIndex: [],
    primarySourceIds: [],
    recommendedThesis: "",
    recommendedArticleType: "unknown",
    recommendedStructure: [],
    researchConfidence: 0,
    researchSufficiency: {
      score: 0,
      threshold: 70,
      components: {
        primarySources: 0,
        sourceDiversity: 0,
        extractionQuality: 0,
        claimCoverage: 0,
        recency: 0,
        scope: 0,
      },
      penalties: { conflicts: 0, unknowns: 15, weakSources: 0 },
      explanation: [],
    },
    sufficient: false,
    blockingReasons: [
      "No supported factual claims were extracted",
      "A primary source is required",
    ],
    warnings: [],
    contentHashes: [],
    provenance: {
      deterministic: true,
      promptVersion: "research-synthesis-v1",
    },
  });
}

export function assistedResearchFixture(
  packet: ResearchPacket,
  executiveSummary: string,
) {
  return {
    schemaVersion: "1.0" as const,
    topicId: packet.topicId,
    approvedEventId: packet.approvedEventId,
    sourcePacketVersion: 1,
    executiveSummary,
    interpretations: [],
    predictions: [],
    counterpoints: [],
    unknowns: ["Supported factual detail is still required"],
    recommendedThesis: "Do not draft without supported evidence.",
    recommendedArticleType: "unknown" as const,
    recommendedStructure: [],
  };
}

export function researchSourceFixture(value: string, contentHash: string) {
  const topicId = `topic_manual_${value}`;
  return researchSourceSchema.parse({
    id: `source_${value}`,
    topicId,
    originalUrl: `https://example.com/${value}`,
    canonicalUrl: `https://example.com/${value}`,
    finalUrl: `https://example.com/${value}`,
    title: "Versioned research source fixture",
    publisher: "example.com",
    publisherGroup: "example.com",
    sourceType: "technical_reporting",
    authority: "independent",
    isPrimary: false,
    retrievedAt: researchVersioningNow,
    contentType: "text/plain",
    language: "en",
    contentHash,
    extractionMethod: "text",
    extractionStatus: "extracted",
    extractionQuality: "high",
    qualityMetrics: {
      wordCount: 3,
      paragraphCount: 1,
      headingCount: 0,
      metadataFields: 0,
    },
    wordCount: 3,
    summary: "Versioned source fixture.",
    selectedExcerpts: [],
    licenseNotes: "Test fixture.",
    warnings: [],
    rawMetadata: {},
  });
}
