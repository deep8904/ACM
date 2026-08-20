import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAtomicJson } from "../../discovery/persistence";
import {
  FailoverAIProvider,
  GroqAIProvider,
  OpenRouterAIProvider,
  estimateAIRequest,
} from "../../llm/provider";
import { researchPacketSchema } from "../../research/models";
import {
  articleWritingResultSchema,
  draftClaimReferenceSchema,
} from "../models";
import { loadWritingConfig } from "../config";
import { inspectMdx } from "../mdx";
import {
  normalizeGeneratedArticle,
  normalizeGeneratedArticleIdentity,
} from "../normalize-generated";
import { WritingService } from "../service";
import { selectArticleType } from "../article-type";
import {
  FileArticleDraftRepository,
  FileArticleHistoryRepository,
  FileDraftQualityRepository,
  FileWritingJobRepository,
  FileWritingTaskRepository,
} from "../storage";
import { createWritingTask, sha256 } from "../task";
import { evaluateDraft } from "../quality";

const now = "2026-08-06T12:00:00.000Z";
const sourceId = "source_aaaaaaaaaaaaaaaaaaaaaaaa";
const claimId = "claim_aaaaaaaaaaaaaaaaaaaaaaaa";
function packet(overrides: Record<string, unknown> = {}) {
  return researchPacketSchema.parse({
    id: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
    version: 1,
    topicId: "topic_fixture",
    candidateId: "candidate_fixture",
    runId: "run_fixture",
    approvedEventId: "event_aaaaaaaaaaaaaaaaaaaaaaaa",
    origin: "manual_topic",
    approvedTitle: "Widget Offline Mode Explained",
    approvedAngle: "Explain what changed and why developers should care",
    editorialNotes: [],
    createdAt: now,
    updatedAt: now,
    status: "ready",
    researchMode: "deterministic",
    scope: ["release"],
    executiveSummary:
      "Widget now supports an offline mode for local developer workflows.",
    timeline: [],
    facts: [
      {
        id: claimId,
        topicId: "topic_fixture",
        statement: "Widget supports offline mode.",
        normalizedStatement: "widget supports offline mode",
        claimType: "fact",
        sourceIds: [sourceId],
        supportingExcerptIds: ["excerpt_1"],
        confidence: 0.95,
        status: "supported",
        disagreementSourceIds: [],
        notes: [],
        createdAt: now,
      },
    ],
    interpretations: [],
    predictions: [],
    communityObservations: [],
    technicalDetails: ["Offline mode stores work locally."],
    productSpecifications: [],
    counterpoints: ["Some collaboration features still require a connection."],
    conflicts: [],
    unknowns: [],
    sourceIndex: [
      {
        id: sourceId,
        topicId: "topic_fixture",
        originalUrl: "https://example.com/release",
        canonicalUrl: "https://example.com/release",
        finalUrl: "https://example.com/release",
        title: "Widget release notes",
        publisher: "Widget",
        publisherGroup: "Widget",
        sourceType: "release_notes",
        authority: "primary",
        isPrimary: true,
        publishedAt: now,
        retrievedAt: now,
        contentType: "text/html",
        language: "en",
        contentHash: "a".repeat(64),
        extractionMethod: "html",
        extractionStatus: "extracted",
        extractionQuality: "high",
        qualityMetrics: {
          wordCount: 100,
          paragraphCount: 4,
          headingCount: 1,
          metadataFields: 3,
        },
        wordCount: 100,
        summary: "Official release notes for offline mode.",
        selectedExcerpts: [
          {
            id: "excerpt_1",
            text: "Widget supports offline mode.",
            locator: "paragraph 2",
            purpose: "feature confirmation",
          },
        ],
        licenseNotes: "Short excerpt for reporting",
        warnings: [],
        rawMetadata: {},
      },
    ],
    primarySourceIds: [sourceId],
    recommendedThesis:
      "Offline mode makes Widget more resilient for developers.",
    recommendedArticleType: "news_analysis",
    recommendedStructure: ["What changed", "Why it matters"],
    researchConfidence: 0.9,
    researchSufficiency: {
      score: 90,
      threshold: 70,
      components: {
        primarySources: 20,
        sourceDiversity: 10,
        extractionQuality: 20,
        claimCoverage: 20,
        recency: 10,
        scope: 10,
      },
      penalties: { conflicts: 0, unknowns: 0, weakSources: 0 },
      explanation: ["Primary evidence available"],
    },
    sufficient: true,
    blockingReasons: [],
    warnings: [],
    contentHashes: ["a".repeat(64)],
    provenance: { deterministic: true, promptVersion: "v1" },
    ...overrides,
  });
}
function result(overrides: Record<string, unknown> = {}) {
  return articleWritingResultSchema.parse({
    schemaVersion: "1.0",
    topicId: "topic_fixture",
    researchPacketId: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
    researchPacketVersion: 1,
    articleType: "news_analysis",
    metadata: {
      title: "Widget Offline Mode Changes Developer Workflows",
      alternateTitles: [
        "What Widget Offline Mode Means for Developers",
        "Widget Adds Offline Work for Developers",
      ],
      seoTitle: "Widget Offline Mode for Developers",
      socialHeadline: "Widget now works offline",
      slug: "widget-offline-mode-developer-workflows",
      description:
        "Widget's new offline mode changes how developers can work when a stable connection is unavailable.",
      excerpt:
        "A source-based analysis of Widget's offline mode and its practical limits.",
      category: "Development",
      tags: ["Widget", "offline"],
      author: "Deep",
      heroImage: null,
      heroAlt: "Abstract local and cloud workflow diagram",
      canonicalUrl: null,
      publishedAt: null,
      status: "draft",
      draft: true,
    },
    mdx: "Widget now supports offline work, according to its release notes. This analysis explains the practical boundary without claiming hands-on testing. [source:source_aaaaaaaaaaaaaaaaaaaaaaaa]\n\n## Event\n\nThe official release says Widget supports offline mode. [source:source_aaaaaaaaaaaaaaaaaaaaaaaa]\n\n## Context\n\nThe change addresses work that must continue through an unreliable connection.\n\n## Meaning\n\nLocal continuity is useful, but it does not make every connected feature available offline.\n\n## Impact by audience\n\nIndividual developers may gain resilience while collaborative teams still need connectivity.\n\n## Counterpoints\n\nThe supplied evidence does not establish how every integration behaves without a connection.\n\n## Outlook\n\nOffline mode is a resilience feature, not a complete replacement for connected collaboration.",
    plainTextSummary:
      "Widget's offline mode can make individual developer work more resilient, while connected collaboration remains a limitation.",
    headingOutline: [
      { level: 2, text: "Event" },
      { level: 2, text: "Context" },
      { level: 2, text: "Meaning" },
      { level: 2, text: "Impact by audience" },
      { level: 2, text: "Counterpoints" },
      { level: 2, text: "Outlook" },
    ],
    claimReferences: [
      {
        id: "draftclaim_aaaaaaaaaaaaaaaaaaaaaaaa",
        statement: "Widget supports offline mode.",
        claimType: "fact",
        researchClaimIds: [claimId],
        sourceIds: [sourceId],
        section: "Event",
        supportStatus: "supported",
        notes: [],
      },
    ],
    sourceIdsUsed: [sourceId],
    declaredAnalysisSections: ["Practical impact"],
    declaredOpinionSections: [],
    limitations: ["Collaboration may require connectivity."],
    heroImageBrief: {
      editorialPurpose: "Explain local versus connected work",
      subject: "A local workstation connected to a muted cloud",
      composition: "Editorial split composition",
      mood: "Practical and calm",
      background: "Neutral dark background",
      aspectRatio: "16:9",
      recommendation: "diagram",
      mustNotDepict: ["A fabricated product interface"],
      altTextDraft:
        "Diagram contrasting local offline work with connected collaboration",
      misinformationRisk: "Avoid implying every feature works offline.",
    },
    suggestedSeoMetadata: {
      keywords: ["Widget offline mode"],
      searchIntent: "Understand the release",
    },
    writerNotes: [],
    unresolvedQuestions: [],
    ...overrides,
  });
}

describe("Milestone 5 writing boundary", () => {
  it("restores immutable writing identity before schema validation", () => {
    const normalized = normalizeGeneratedArticleIdentity(
      { ...result(), schemaVersion: "2.0", topicId: "wrong" },
      {
        topicId: "topic_fixture",
        researchPacketId: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
        researchPacketVersion: 1,
        articleType: "news_analysis",
      },
    );

    expect(articleWritingResultSchema.parse(normalized)).toMatchObject({
      schemaVersion: "1.0",
      topicId: "topic_fixture",
      researchPacketId: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
      researchPacketVersion: 1,
      articleType: "news_analysis",
    });
  });

  it("moves heading citations into the body and aligns section identities", () => {
    const generated = result({
      mdx: result().mdx.replace("## Event", `## Event [source:${sourceId}]`),
      headingOutline: result().headingOutline.map((heading) =>
        heading.text === "Event"
          ? { ...heading, text: `Event [source:${sourceId}]` }
          : heading,
      ),
      claimReferences: result().claimReferences.map((reference) => ({
        ...reference,
        section: `Event [source:${sourceId}]`,
      })),
    });

    const normalized = normalizeGeneratedArticle(generated);

    expect(normalized.mdx).toContain(`## Event\n\n[source:${sourceId}]`);
    expect(normalized.mdx).not.toContain(`## Event [source:${sourceId}]`);
    expect(normalized.headingOutline[0]?.text).toBe("Event");
    expect(normalized.claimReferences[0]?.section).toBe("Event");
  });

  it("compresses a large research packet without losing evidence and fits the Groq route", async () => {
    const config = await loadWritingConfig(
      "automation/config/writing.example.yaml",
    );
    const research = packet({
      executiveSummary: "A concise verified summary.",
      technicalDetails: ["raw detail ".repeat(4_000)],
      sourceIndex: packet().sourceIndex.map((source) => ({
        ...source,
        summary: "raw source history ".repeat(2_000),
      })),
    });
    const bundle = await createWritingTask(
      research,
      "news_analysis",
      {
        warnings: [],
        substantialMatches: [],
        exactTitle: false,
        slugCollision: false,
        sameTopic: false,
        sameEvent: false,
      },
      config,
      {
        prompt: "prompts/article-writer.md",
        audience: "brand/audience.md",
        style: "brand/writing-style.md",
        editorial: "brand/editorial-rules.md",
        design: "brand/design-style.md",
        template: "templates/article.mdx",
      },
      now,
    );
    const input = bundle.input as {
      brief: { requiredFacts: string[] };
      verifiedEvidence: {
        claims: { id: string; statement: string }[];
        sources: { id: string }[];
        excerpts: { id: string; sourceId: string }[];
      };
      citations: { sourceId: string }[];
      preparationAudit: {
        rawCharacters: number;
        preparedCharacters: number;
      };
    };
    expect(input.preparationAudit.rawCharacters).toBeGreaterThan(70_000);
    expect(input.preparationAudit.preparedCharacters).toBeLessThan(12_000);
    expect(input.brief.requiredFacts).toEqual([claimId]);
    expect(input.verifiedEvidence.claims).toContainEqual(
      expect.objectContaining({
        id: claimId,
        statement: "Widget supports offline mode.",
      }),
    );
    expect(input.verifiedEvidence.sources.map((source) => source.id)).toEqual([
      sourceId,
    ]);
    expect(input.verifiedEvidence.excerpts).toContainEqual(
      expect.objectContaining({ id: "excerpt_1", sourceId }),
    );
    expect(input.citations).toContainEqual(
      expect.objectContaining({ sourceId }),
    );

    const request = {
      jobId: `automationjob_${"a".repeat(24)}`,
      stage: "writing" as const,
      system: "Write the article from the prepared brief.",
      task: input,
      schema: articleWritingResultSchema,
    };
    expect(estimateAIRequest(request).size).toBe("medium");
    let groqCalls = 0;
    const groq = new GroqAIProvider({
      apiKey: "test",
      model: "openai/gpt-oss-120b",
      fetch: async () => {
        groqCalls += 1;
        return Response.json({ id: "openai/gpt-oss-120b" });
      },
    });
    const openrouter = new OpenRouterAIProvider({
      apiKey: "test",
      model: "openai/gpt-oss-120b",
      fetch: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify(result()) } }],
        }),
    });
    await expect(
      new FailoverAIProvider([groq, openrouter]).generate(request),
    ).resolves.toMatchObject({
      provider: "openrouter",
      value: { topicId: research.topicId },
    });
    expect(groqCalls).toBe(0);
  });

  it("uses strict structured output schemas", () =>
    expect(() =>
      articleWritingResultSchema.parse({ ...result(), extra: true }),
    ).toThrow());
  it.each([
    "import x from 'x'",
    "<script>alert(1)</script>",
    "{process.env.SECRET}",
    "[x](javascript:alert(1))",
    "[x](/../../secret)",
    "https://127.0.0.1/admin",
  ])("blocks unsafe MDX: %s", (value) =>
    expect(inspectMdx(value, new Set()).safetyIssues.length).toBeGreaterThan(0),
  );
  it("allows fenced code without treating it as executable MDX", () =>
    expect(
      inspectMdx("```tsx\n<Component onClick={x} />\n```\n\n## Safe", new Set())
        .safetyIssues,
    ).toEqual([]));
  it("returns explainable article-type compatibility failures", async () => {
    const baseConfig = await loadWritingConfig(
      "automation/config/writing.example.yaml",
    );
    const config = {
      ...baseConfig,
      wordRanges: {
        ...baseConfig.wordRanges,
        news_analysis: { min: 50, max: 200 },
      },
    };
    expect(() =>
      selectArticleType(
        packet({ technicalDetails: [] }),
        "tutorial_candidate",
        config,
        new Date(now),
      ),
    ).toThrow(/actionable technical/);
    expect(() =>
      selectArticleType(packet(), "source_based_review", config, new Date(now)),
    ).toThrow(/product specifications/);
    expect(() =>
      selectArticleType(packet(), "comparison", config, new Date(now)),
    ).toThrow(/at least two/);
    expect(() =>
      selectArticleType(packet(), "breaking_news", config, new Date(now)),
    ).toThrow(/newer than/);
    expect(
      selectArticleType(packet(), "technical_explainer", config, new Date(now)),
    ).toBe("technical_explainer");
  });
  it("blocks unknown evidence, citation-poor facts, and fake hands-on claims", async () => {
    const config = await loadWritingConfig(
      "automation/config/writing.example.yaml",
    );
    const assess = (value: ReturnType<typeof result>) =>
      evaluateDraft(
        value,
        packet(),
        value.claimReferences.map((x) =>
          draftClaimReferenceSchema.parse({
            ...x,
            draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
          }),
        ),
        config,
        "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
        1,
        now,
      );
    expect(
      assess(result({ sourceIdsUsed: ["source_bbbbbbbbbbbbbbbbbbbbbbbb"] }))
        .blockingIssues,
    ).toContain("Unknown declared source: source_bbbbbbbbbbbbbbbbbbbbbbbb");
    const poor = result({
      mdx: "A sufficiently long introduction explains the context and limitations before the structured analysis begins.\n\n## What changed\n\nWidget supports offline mode.\n\n## Takeaway\n\nConnectivity is still useful.",
    });
    expect(assess(poor).blockingIssues).toContain(
      "One or more critical claims lack a matching inline citation",
    );
    expect(
      assess(
        result({ mdx: `${result().mdx}\n\nWe tested the product for a week.` }),
      ).blockingIssues,
    ).toContain("Unapproved first-hand experience or testing claim");
  });
  it("requires disclosure for source-based product analysis and reports style warnings", async () => {
    const config = await loadWritingConfig(
      "automation/config/writing.example.yaml",
    );
    const value = result({
      articleType: "buying_analysis",
      mdx: `${result().mdx}\n\nThis changes everything!`,
    });
    const report = evaluateDraft(
      value,
      packet(),
      value.claimReferences.map((x) =>
        draftClaimReferenceSchema.parse({
          ...x,
          draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ),
      config,
      "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      1,
      now,
    );
    expect(report.blockingIssues).toContain(
      "Required source-based review disclosure is missing",
    );
    expect(report.forbiddenLanguage).toContain("this changes everything");
  });

  it("prepares a pinned task, imports once, and persists an unapproved immutable draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-flow-"));
    const config = await loadWritingConfig(
      "automation/config/writing.example.yaml",
    );
    const research = packet();
    const drafts = new FileArticleDraftRepository(join(root, "writing"));
    const upstream = {
      approval: { id: research.approvedEventId, status: "ready" },
      packet: research,
      ranking: { topicId: research.topicId, score: 91 },
    };
    await writeAtomicJson(
      join(root, "upstream", "approval.json"),
      upstream.approval,
    );
    await writeAtomicJson(
      join(root, "upstream", "packet.json"),
      upstream.packet,
    );
    await writeAtomicJson(
      join(root, "upstream", "ranking.json"),
      upstream.ranking,
    );
    const upstreamBefore = await Promise.all(
      ["approval", "packet", "ranking"].map((name) =>
        readFile(join(root, "upstream", `${name}.json`), "utf8"),
      ),
    );
    const service = new WritingService({
      packets: {
        nextVersion: async () => 2,
        save: async () => undefined,
        get: async (topic, version) =>
          topic === research.topicId && (!version || version === 1)
            ? research
            : undefined,
        getByImportHash: async () => undefined,
      },
      jobs: new FileWritingJobRepository(join(root, "writing")),
      drafts,
      quality: new FileDraftQualityRepository(drafts),
      history: new FileArticleHistoryRepository(join(root, "writing")),
      tasks: new FileWritingTaskRepository(join(root, "tasks")),
      gates: {
        event: async () => ({
          id: research.approvedEventId,
          topicId: research.topicId,
          candidateId: research.candidateId,
          runId: research.runId,
          approvedAt: now,
          approvedBy: { telegramUserId: "1", telegramChatId: "1" },
          approvedAngle: research.approvedAngle,
          editorialNotes: [],
          sourceItemIds: [],
          origin: "manual_topic",
          status: "ready",
          consumed: false,
          version: 1,
        }),
        queue: async () =>
          ({
            topicId: research.topicId,
            candidateId: research.candidateId,
            approvalStatus: "approved",
            researchReadiness: "ready_for_research",
            triggerState: "topic_approved_event_created",
          }) as never,
      },
      config,
      configHash: sha256(JSON.stringify(config)),
      paths: {
        prompt: "prompts/article-writer.md",
        audience: "brand/audience.md",
        style: "brand/writing-style.md",
        editorial: "brand/editorial-rules.md",
        design: "brand/design-style.md",
        template: "templates/article.mdx",
      },
      clock: () => new Date(now),
      workerId: "test",
    });
    const prepared = await service.prepare(research.topicId, 1);
    expect(prepared.job.status).toBe("awaiting_manual_writing");
    const writingInstructions = await readFile(
      join(root, "tasks", research.topicId, "v1", "article-writing.md"),
      "utf8",
    );
    expect(writingInstructions).toContain("Do not browse");
    expect(writingInstructions).toContain(
      "every claimReferences[].section exactly matches an H2-H4 heading",
    );
    expect(writingInstructions).toContain(
      "every source ID on a claim reference is listed on that research claim",
    );
    const writingInput = JSON.parse(
      await readFile(
        join(root, "tasks", research.topicId, "v1", "writing-input.json"),
        "utf8",
      ),
    ) as { brief: { mdxRequirements: string[] } };
    expect(writingInput.brief.mdxRequirements).toContain(
      "Every claimReferences[].section value must exactly match the text of an H2-H4 heading in mdx",
    );
    await writeAtomicJson(
      join(root, "tasks", research.topicId, "v1", "writing-input.json"),
      { ...writingInput, preparationVersion: "1.0" },
    );
    const upgraded = await service.prepare(research.topicId, 1);
    expect(upgraded.job.id).toBe(prepared.job.id);
    expect(
      JSON.parse(
        await readFile(
          join(root, "tasks", research.topicId, "v1", "writing-input.json"),
          "utf8",
        ),
      ).preparationVersion,
    ).toBe("2.0");
    const output = join(root, "writer-result.json");
    await writeAtomicJson(output, result());
    const imported = await service.import(research.topicId, 1, output);
    expect(imported.draft.status).toBe("validated");
    expect(imported.draft.publishedAt).toBeNull();
    expect(imported.draft.canonicalUrl).toBeNull();
    expect(
      await readFile(
        join(root, "writing", "drafts", research.topicId, "v1", "article.mdx"),
        "utf8",
      ),
    ).toContain("Not editorially reviewed or approved");
    expect((await service.import(research.topicId, 1, output)).reused).toBe(
      true,
    );
    const original = await readFile(
      join(root, "writing", "drafts", research.topicId, "v1", "draft.json"),
      "utf8",
    );
    const replay = await service.prepare(research.topicId, 1);
    expect(replay.job.id).toBe(prepared.job.id);
    expect(replay.job.taskHash).toBe(prepared.job.taskHash);
    const modifiedPath = join(root, "writer-result-modified.json");
    await writeAtomicJson(
      modifiedPath,
      result({ writerNotes: ["Second valid manual pass"] }),
    );
    const modified = await service.import(research.topicId, 1, modifiedPath);
    expect(modified.draft.version).toBe(2);
    expect(modified.draft.supersedesVersion).toBe(1);
    expect(modified.draft.id).toBe(imported.draft.id);
    expect(
      await readFile(
        join(root, "writing", "drafts", research.topicId, "v1", "draft.json"),
        "utf8",
      ),
    ).toBe(original);
    expect(await drafts.nextVersion(research.topicId)).toBe(3);
    const upstreamAfter = await Promise.all(
      ["approval", "packet", "ranking"].map((name) =>
        readFile(join(root, "upstream", `${name}.json`), "utf8"),
      ),
    );
    expect(upstreamAfter).toEqual(upstreamBefore);
    await expect(access(join(root, "publishing"))).rejects.toThrow();
    await expect(access(join(root, "final-approval"))).rejects.toThrow();
  });

  it("rejects ineligible packets before task creation", async () => {
    const config = await loadWritingConfig(
      "automation/config/writing.example.yaml",
    );
    const research = packet({
      status: "insufficient",
      sufficient: false,
      blockingReasons: ["missing evidence"],
    });
    const service = new WritingService({
      packets: {
        nextVersion: async () => 1,
        save: async () => undefined,
        get: async () => research,
        getByImportHash: async () => undefined,
      },
      jobs: { get: async () => undefined } as never,
      drafts: {} as never,
      quality: {} as never,
      history: {} as never,
      tasks: {} as never,
      gates: { event: async () => undefined, queue: async () => undefined },
      config,
      configHash: "a".repeat(64),
      paths: {} as never,
    });
    await expect(service.prepare(research.topicId, 1)).rejects.toThrow(
      /not eligible/,
    );
  });
});
