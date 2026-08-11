import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWritingEligibility } from "../../writing/eligibility";
import { researchConfigSchema } from "../config";
import type {
  ApprovedEventRepository,
  ResearchSourceExtensionRepository,
} from "../interfaces";
import {
  evidenceClaimSchema,
  researchPacketSchema,
  researchSourceSchema,
} from "../models";
import { ResearchService } from "../service";
import { writeAssistanceTask } from "../assisted";
import type { ResearchFetch } from "../retrieve";
import {
  FileResearchJobRepository,
  FileHumanAssistedEvidenceRepository,
  FileResearchPacketRepository,
  FileResearchSourceExtensionRepository,
  FileResearchSourceRepository,
} from "../storage";

const now = "2026-08-09T18:00:00.000Z";
const topicId = "topic_aaaaaaaaaaaaaaaaaaaaaaaa";
const event = {
  id: "event_aaaaaaaaaaaaaaaaaaaaaaaa",
  topicId,
  candidateId: topicId,
  runId: "run_extension",
  approvedAt: now,
  approvedBy: { telegramUserId: "1", telegramChatId: "1" },
  approvedAngle: "Explain the API change",
  editorialNotes: [],
  sourceItemIds: ["item_blog"],
  origin: "ranked" as const,
  status: "ready" as const,
  consumed: false as const,
  version: 1,
};
const queue = {
  topicId,
  candidateId: topicId,
  approvalStatus: "approved",
  researchReadiness: "ready_for_research",
  triggerState: "topic_approved_event_created",
  candidateSnapshot: {
    kind: "ranked",
    candidate: { title: "Copilot usage metrics" },
  },
};

describe("research source extension", () => {
  it("persists official human-assisted evidence and one immutable packet version idempotently", async () => {
    const fixture = await createFixture();
    const input = {
      topicId,
      remediationId: "remediation_aaaaaaaaaaaaaaaaaaaaaaaa",
      eventId: event.id,
      jobId: "automationjob_aaaaaaaaaaaaaaaaaaaaaaaa",
      url: fieldReference().url,
      evidenceText:
        "GitHub states that the Copilot usage metrics API includes totals by third-party agent. Each entry has an agent identifier and agent name, and the report includes aggregated session counts for supported enterprise reporting workflows.",
      operatorActorHash: "b".repeat(64),
      provenanceStatement:
        "I copied this evidence from the official GitHub page shown above.",
      originalFailureCode: "429_cooldown" as const,
      originalDiagnosticId: "diag_a4976f04b106b3e8",
    };

    const accepted = await fixture.service.acceptHumanAssistedEvidence(input);
    const replay = await fixture.service.acceptHumanAssistedEvidence(input);

    expect(accepted.version).toBe(2);
    expect(accepted.status).toBe("awaiting_assisted_synthesis");
    expect(accepted.sufficient).toBe(false);
    expect(replay.version).toBe(2);
    expect((await fixture.packets.get(topicId))?.version).toBe(2);
    expect(accepted.provenance.humanAssistedEvidence).toMatchObject({
      acquisitionMode: "human_assisted_primary_evidence",
      canonicalUrl: fieldReference().url,
      operatorActorHash: "b".repeat(64),
      originalRetrievalFailure: {
        code: "429_cooldown",
        diagnosticId: "diag_a4976f04b106b3e8",
      },
    });
    expect(
      accepted.sourceIndex.find(
        (source) =>
          source.acquisitionMode === "human_assisted_primary_evidence",
      ),
    ).toMatchObject({
      authority: "primary",
      extractionMethod: "human_evidence",
    });
    const taskDir = await writeAssistanceTask(
      accepted,
      join(fixture.root, "tasks"),
      "prompts/research-synthesis.md",
    );
    const task = JSON.parse(
      await readFile(join(taskDir, "research-input.json"), "utf8"),
    );
    expect(task.sourceHierarchy).toContainEqual(
      expect.objectContaining({
        acquisitionMode: "human_assisted_primary_evidence",
        evidenceRecordId:
          accepted.provenance.humanAssistedEvidence?.evidenceRecordId,
      }),
    );
  });

  it("rejects third-party, blank, and oversized human evidence", async () => {
    const fixture = await createFixture();
    const base = {
      topicId,
      remediationId: "remediation_aaaaaaaaaaaaaaaaaaaaaaaa",
      eventId: event.id,
      jobId: "automationjob_aaaaaaaaaaaaaaaaaaaaaaaa",
      operatorActorHash: "b".repeat(64),
      provenanceStatement: "I copied this evidence from the official page.",
      originalFailureCode: "403_forbidden" as const,
      originalDiagnosticId: "diag_a4976f04b106b3e8",
    };
    await expect(
      fixture.service.acceptHumanAssistedEvidence({
        ...base,
        url: "https://example.net/report/copilot-metrics",
        evidenceText:
          "A third-party report contains enough words and characters to otherwise pass the content size check, but it must never become primary evidence for this official publisher topic under any circumstances.",
      }),
    ).rejects.toThrow(/verified official publisher URL/);
    await expect(
      fixture.service.acceptHumanAssistedEvidence({
        ...base,
        url: fieldReference().url,
        evidenceText: "   ",
      }),
    ).rejects.toThrow();
    await expect(
      fixture.service.acceptHumanAssistedEvidence({
        ...base,
        url: fieldReference().url,
        evidenceText: "x".repeat(20_001),
      }),
    ).rejects.toThrow();
    expect((await fixture.packets.get(topicId))?.version).toBe(1);
  });

  it("inspects an official owner without silently adding or escalating it", async () => {
    const fixture = await createFixture();
    const proposal = await fixture.service.inspectSource({
      topicId,
      url: fieldReference().url,
    });
    expect(proposal.proposedAuthority).toBe("primary");
    expect(proposal.publisherOwner).toBe("github.com");
    expect(proposal.sourceType).toBe("documentation");
    expect((await fixture.packets.get(topicId))?.version).toBe(1);
    expect(await fixture.sources.list(topicId)).toHaveLength(0);
  });

  it("keeps an awaiting-source topic active for inspection and explicit extension", async () => {
    const fixture = await createFixture(
      undefined,
      true,
      undefined,
      "awaiting_source",
    );

    const proposal = await fixture.service.inspectSource({
      topicId,
      url: fieldReference().url,
    });
    expect(proposal.proposedAuthority).toBe("primary");
    expect((await fixture.packets.get(topicId))?.version).toBe(1);

    const extended = await fixture.service.extendSource(fieldReference());
    expect(extended.version).toBe(2);
  });

  it("keeps unknown ownership independent and rejects unsafe or duplicate URLs", async () => {
    const fixture = await createFixture();
    const proposal = await fixture.service.inspectSource({
      topicId,
      url: "https://example.net/report/copilot-metrics",
    });
    expect(proposal.proposedAuthority).toBe("independent");
    await expect(
      fixture.service.inspectSource({
        topicId,
        url: "http://127.0.0.1/private",
      }),
    ).rejects.toThrow(/private|local/);
    await expect(
      fixture.service.inspectSource({
        topicId,
        url: "file:///tmp/source",
      }),
    ).rejects.toThrow(/HTTP and HTTPS/);
    await expect(
      fixture.service.inspectSource({
        topicId,
        url: "https://github.blog/changelog/copilot-agent-activity",
      }),
    ).rejects.toThrow(/already in the latest/);
  });

  it.each([
    ["rate limit", 429, /rate-limiting/],
    ["forbidden", 403, /refused retrieval/],
  ])(
    "reports %s retrieval failures without persisting evidence",
    async (_label, status, message) => {
      const fixture = await createFixture(undefined, true, async (url) =>
        url.endsWith("/robots.txt")
          ? new Response("User-agent: *\nAllow: /", {
              headers: { "content-type": "text/plain" },
            })
          : new Response("blocked", { status }),
      );
      await expect(
        fixture.service.inspectSource({
          topicId,
          url: "https://example.net/source",
        }),
      ).rejects.toThrow(message);
      expect(await fixture.sources.list(topicId)).toHaveLength(0);
    },
  );

  it("reports robots exclusions without persisting evidence", async () => {
    const fixture = await createFixture(undefined, true, async (url) =>
      url.endsWith("/robots.txt")
        ? new Response("User-agent: *\nDisallow: /", {
            headers: { "content-type": "text/plain" },
          })
        : new Response("unused"),
    );
    await expect(
      fixture.service.inspectSource({
        topicId,
        url: "https://example.net/source",
      }),
    ).rejects.toThrow(/robots/);
  });

  it("extends a consumed topic twice without changing old versions or inflating publisher diversity", async () => {
    const fixture = await createFixture();
    const v1 = await fixture.packets.get(topicId, 1);
    const v2 = await fixture.service.extendSource(fieldReference());
    const v3 = await fixture.service.extendSource(exampleSchema());

    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect(await fixture.packets.get(topicId, 1)).toEqual(v1);
    expect((await fixture.packets.get(topicId, 2))?.sourceIndex).toHaveLength(
      2,
    );
    expect(v3.sourceIndex).toHaveLength(3);
    expect(
      v3.sourceIndex.every((source) => source.authority === "primary"),
    ).toBe(true);
    expect(
      v3.sourceIndex.slice(1).map((source) => source.publisherOwner),
    ).toEqual(["github.com", "github.com"]);
    expect(v3.researchSufficiency.components.sourceDiversity).toBe(7);
    expect(v3.researchSufficiency.components.scope).toBe(5);
    expect(v3.researchSufficiency.penalties.unknowns).toBe(15);
    expect(v3.status).toBe("awaiting_assisted_synthesis");
    expect(v3.sufficient).toBe(false);
    expect(fixture.consumeCalls).toBe(0);
  });

  it("is idempotent for an exact duplicate and rejects conflicting duplicate metadata", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.extendSource(fieldReference());
    const replayed = await fixture.service.extendSource(fieldReference());
    expect(replayed.version).toBe(created.version);
    expect(await fixture.packets.nextVersion(topicId)).toBe(3);
    await expect(
      fixture.service.extendSource({
        ...fieldReference(),
        authority: "independent",
      }),
    ).rejects.toThrow(
      /different classification|cannot be classified independent/,
    );
  });

  it("rejects unsupported authority escalation and GitHub-owned independent classification", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.service.extendSource({
        ...fieldReference(),
        publisherOwner: "example.com",
      }),
    ).rejects.toThrow(/ownership/);
    await expect(
      fixture.service.extendSource({
        ...fieldReference(),
        authority: "independent",
      }),
    ).rejects.toThrow(/cannot be classified independent/);
    await expect(
      fixture.service.extendSource({
        ...fieldReference(),
        sourceType: "technical_reporting",
      }),
    ).rejects.toThrow(/unsupported/);
  });

  it("publishes no packet or source when atomic persistence fails", async () => {
    const fixture = await createFixture({
      persist: async () => {
        throw new Error("transaction rolled back");
      },
    });
    await expect(
      fixture.service.extendSource(fieldReference()),
    ).rejects.toThrow(/rolled back/);
    expect((await fixture.packets.get(topicId))?.version).toBe(1);
    expect(await fixture.sources.list(topicId)).toHaveLength(0);
  });

  it("requires a consumed, actively approved topic and cannot bypass writing eligibility", async () => {
    const unconsumed = await createFixture(undefined, false);
    await expect(
      unconsumed.service.extendSource(fieldReference()),
    ).rejects.toThrow(/only supported for consumed/);

    const fixture = await createFixture();
    const extended = await fixture.service.extendSource(fieldReference());
    expect(() =>
      assertWritingEligibility(extended, event, queue as never),
    ).toThrow(/awaiting_assisted_synthesis|insufficient/);
  });
});

async function createFixture(
  extensionOverride?: ResearchSourceExtensionRepository,
  consumed = true,
  fetchOverride?: ResearchFetch,
  queueResearchReadiness:
    "ready_for_research" | "awaiting_source" = "ready_for_research",
) {
  const root = await mkdtemp(join(tmpdir(), "source-extension-"));
  const packets = new FileResearchPacketRepository(root);
  const sources = new FileResearchSourceRepository(root);
  await packets.save(basePacket());
  let consumeCalls = 0;
  const events: ApprovedEventRepository = {
    next: async () => undefined,
    get: async (id) => (id === event.id ? event : undefined),
    queue: async () =>
      ({
        ...queue,
        researchReadiness: queueResearchReadiness,
      }) as never,
    isCancelled: async () => false,
    isConsumed: async () => consumed,
    consume: async () => {
      consumeCalls += 1;
    },
  };
  const service = new ResearchService({
    events,
    jobs: new FileResearchJobRepository(root),
    packets,
    sources,
    cache: sources,
    extensions:
      extensionOverride ?? new FileResearchSourceExtensionRepository(root),
    humanEvidence: new FileHumanAssistedEvidenceRepository(root),
    catalog: {
      latestRunId: async () => event.runId,
      getRun: async () => ({
        runId: event.runId,
        candidates: [],
        clusters: [],
        sourceItems: [],
      }),
    },
    config: researchConfigSchema.parse({ mode: "assisted" }),
    now: () => new Date(now),
    lookup: async () => ["93.184.216.34"],
    fetch:
      fetchOverride ??
      (async (url) =>
        url.endsWith("/robots.txt")
          ? new Response("User-agent: *\nAllow: /", {
              headers: { "content-type": "text/plain" },
            })
          : new Response(
              "<html><title>GitHub Copilot usage metrics</title><body><p>The totals_by_3rd_party_agent field is an array of agent totals.</p><p>Each entry includes agent_id and agent_name values.</p><p>Reports include job-start counts and aggregated-report session counts.</p></body></html>",
              { headers: { "content-type": "text/html" } },
            )),
  });
  return {
    root,
    service,
    packets,
    sources,
    get consumeCalls() {
      return consumeCalls;
    },
  };
}

function fieldReference() {
  return {
    topicId,
    url: "https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics",
    authority: "primary" as const,
    sourceType: "documentation" as const,
    publisher: "GitHub Docs",
    publisherOwner: "github.com",
  };
}

function exampleSchema() {
  return {
    ...fieldReference(),
    url: "https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-usage-metrics/example-schema",
  };
}

function basePacket() {
  const source = researchSourceSchema.parse({
    id: "source_aaaaaaaaaaaaaaaaaaaaaaaa",
    topicId,
    originalUrl: "https://github.blog/changelog/copilot-agent-activity",
    canonicalUrl: "https://github.blog/changelog/copilot-agent-activity",
    finalUrl: "https://github.blog/changelog/copilot-agent-activity",
    title: "Copilot agent activity",
    publisher: "GitHub Changelog",
    publisherGroup: "github.blog",
    sourceType: "official_announcement",
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
      paragraphCount: 3,
      headingCount: 1,
      metadataFields: 1,
    },
    wordCount: 100,
    summary: "GitHub added agent activity metrics.",
    selectedExcerpts: [
      {
        id: "excerpt_blog_1",
        text: "The API now reports agent app activity by individual agent.",
        locator: "paragraph 1",
        purpose: "factual support",
      },
    ],
    licenseNotes: "Private research",
    warnings: [],
    rawMetadata: {},
  });
  const claim = evidenceClaimSchema.parse({
    id: "claim_aaaaaaaaaaaaaaaaaaaaaaaa",
    topicId,
    statement: "The API reports agent activity.",
    normalizedStatement: "the api reports agent activity",
    claimType: "fact",
    sourceIds: [source.id],
    supportingExcerptIds: [source.selectedExcerpts[0]?.id],
    confidence: 0.9,
    status: "supported",
    disagreementSourceIds: [],
    notes: [],
    createdAt: now,
  });
  return researchPacketSchema.parse({
    id: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
    version: 1,
    topicId,
    candidateId: topicId,
    runId: event.runId,
    approvedEventId: event.id,
    origin: "ranked",
    approvedTitle: "Copilot usage metrics",
    approvedAngle: event.approvedAngle,
    editorialNotes: [],
    createdAt: now,
    updatedAt: now,
    status: "insufficient",
    researchMode: "assisted_import",
    scope: ["approved topic"],
    executiveSummary: "GitHub added agent activity metrics.",
    timeline: [],
    facts: [],
    interpretations: [claim],
    predictions: [],
    communityObservations: [],
    technicalDetails: [],
    productSpecifications: [],
    counterpoints: [],
    conflicts: [],
    unknowns: ["Field semantics remain unknown"],
    sourceIndex: [source],
    primarySourceIds: [source.id],
    recommendedThesis: "Explain the metrics.",
    recommendedArticleType: "news_analysis",
    recommendedStructure: ["What changed"],
    researchConfidence: 0.67,
    researchSufficiency: {
      score: 67,
      threshold: 70,
      components: {
        primarySources: 25,
        sourceDiversity: 7,
        extractionQuality: 20,
        claimCoverage: 20,
        recency: 10,
        scope: 0,
      },
      penalties: { conflicts: 0, unknowns: 15, weakSources: 0 },
      explanation: [],
    },
    sufficient: false,
    blockingReasons: [],
    warnings: [],
    contentHashes: [source.contentHash],
    provenance: { deterministic: false, promptVersion: "v1" },
  });
}
