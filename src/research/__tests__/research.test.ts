import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSourceItem } from "../../discovery/models/source-item";
import { writeAtomicJson } from "../../discovery/persistence";
import { FileTelegramRepository } from "../../telegram/file-repository";
import {
  topicApprovedEventSchema,
  topicQueueItemSchema,
} from "../../telegram/models";
import type { ApprovedEventRepository } from "../interfaces";
import { importAssistance, writeAssistanceTask } from "../assisted";
import { ResearchService } from "../service";
import { extractDocument } from "../extract";
import { GitHubJsonContentExtractor } from "../github-adapter";
import { researchConfigSchema } from "../config";
import {
  evidenceClaimSchema,
  researchPacketSchema,
  researchSourceSchema,
} from "../models";
import { retrieveSafely, robotsAllows } from "../retrieve";
import {
  FileAssistedResearchImportRepository,
  FileResearchJobRepository,
  FileResearchPacketRepository,
  FileResearchSourceRepository,
  FileApprovedEventRepository,
} from "../storage";

describe("research models and extraction", () => {
  it("rejects evidence without a source", () =>
    expect(() => evidenceClaimSchema.parse({})).toThrow());
  it("removes boilerplate and extracts metadata", () => {
    const result = extractDocument(
      '<html><head><title>Release 2</title><meta name="author" content="Deep"></head><body><nav>menu</nav><h1>Release</h1><p>The product is available with 16 GB memory today.</p><script>secret()</script></body></html>',
      "text/html",
      "fallback",
    );
    expect(result.title).toBe("Release 2");
    expect(result.author).toBe("Deep");
    expect(result.text).toContain("16 GB");
    expect(result.text).not.toContain("secret");
  });
  it("treats PDFs as metadata only", () =>
    expect(
      extractDocument("pdf", "application/pdf", "paper").warnings[0],
    ).toMatch(/deferred/));
  it("extracts GitHub release API JSON deterministically", () => {
    const result = new GitHubJsonContentExtractor().extract(
      JSON.stringify({
        tag_name: "v2.0",
        body: "Version 2 supports offline work.",
        published_at: "2026-08-01T00:00:00Z",
        html_url: "https://github.com/acme/widget/releases/tag/v2",
      }),
      "release",
    );
    expect(result.title).toBe("v2.0");
    expect(result.text).toContain("offline");
  });
  it.each([
    ["User-agent: *\nDisallow: /private", "/private/a", false],
    ["User-agent: *\nDisallow: /\nAllow: /public", "/public/a", true],
    ["", "/anything", true],
    ["malformed robots content", "/anything", false],
  ])("applies robots rules", (body, path, allowed) =>
    expect(robotsAllows(body, path)).toBe(allowed),
  );
});

describe("safe retrieval", () => {
  const config = researchConfigSchema.parse({});
  const dns = async () => ["93.184.216.34"];
  it("validates every redirect and retrieves supported content", async () => {
    const seen: string[] = [];
    const value = await retrieveSafely(
      "https://one.example/start",
      config,
      async (url) => {
        seen.push(url);
        return seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://two.example/page" },
            })
          : new Response("hello", {
              headers: { "content-type": "text/plain" },
            });
      },
      dns,
    );
    expect(value.body).toBe("hello");
    expect(seen).toHaveLength(2);
  });
  it("blocks redirects to private hosts", async () => {
    const lookup = async (host: string) =>
      host === "private.example" ? ["127.0.0.1"] : ["93.184.216.34"];
    await expect(
      retrieveSafely(
        "https://one.example",
        config,
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://private.example/a" },
          }),
        lookup,
      ),
    ).rejects.toThrow(/private|reserved|local/);
  });
  it("retrieves a public 192.0 address through a trailing-slash redirect", async () => {
    const seen: string[] = [];
    const value = await retrieveSafely(
      "https://public.example/changelog/item",
      config,
      async (url) => {
        seen.push(url);
        return seen.length === 1
          ? new Response(null, {
              status: 301,
              headers: { location: "/changelog/item/" },
            })
          : new Response("public page", {
              headers: { "content-type": "text/plain" },
            });
      },
      async () => ["192.0.66.2", "::ffff:192.0.66.2"],
    );

    expect(seen).toEqual([
      "https://public.example/changelog/item",
      "https://public.example/changelog/item/",
    ]);
    expect(value.finalUrl).toBe("https://public.example/changelog/item/");
    expect(value.body).toBe("public page");
  });
  it("rejects oversized and unsupported responses", async () => {
    await expect(
      retrieveSafely(
        "https://one.example",
        { ...config, maxBytes: 1024 },
        async () =>
          new Response("x", { headers: { "content-type": "video/mp4" } }),
        dns,
      ),
    ).rejects.toThrow(/Unsupported/);
    await expect(
      retrieveSafely(
        "https://one.example",
        { ...config, maxBytes: 1024 },
        async () =>
          new Response("x", {
            headers: { "content-type": "text/plain", "content-length": "2000" },
          }),
        dns,
      ),
    ).rejects.toThrow(/oversized/);
  });
});

describe("immutable packet storage", () => {
  it("writes private versioned packets and prevents overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-store-"));
    const repo = new FileResearchPacketRepository(root);
    const packet = researchPacketSchema.parse({
      id: "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
      version: 1,
      topicId: "topic",
      candidateId: "candidate",
      runId: "run_test",
      approvedEventId: "event_aaaaaaaaaaaaaaaaaaaaaaaa",
      origin: "manual_topic",
      approvedTitle: "A topic",
      approvedAngle: "An angle",
      editorialNotes: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "insufficient",
      researchMode: "deterministic",
      scope: [],
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
      unknowns: ["sources"],
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
      blockingReasons: ["sources"],
      warnings: [],
      contentHashes: [],
      provenance: { deterministic: true, promptVersion: "v1" },
    });
    await repo.save(packet);
    expect(await repo.get("topic")).toEqual(packet);
    await expect(repo.save(packet)).rejects.toThrow(/already exists/);
    expect(
      (await import("node:fs/promises"))
        .stat(join(root, "packets/topic/v1.json"))
        .then((s) => s.mode & 0o777),
    ).resolves.toBe(0o600);
  });
  it("strict source schemas reject unknown fields", () =>
    expect(() =>
      researchSourceSchema.strict().parse({ unexpected: true }),
    ).toThrow());
  it("records consumption in a sidecar without mutating the approval event", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-event-"));
    const telegramRoot = join(root, "telegram");
    const telegram = new FileTelegramRepository(telegramRoot);
    const now = "2026-08-06T12:00:00.000Z";
    const candidate = {
      id: "topic_manual_aaaaaaaaaaaaaaaaaaaaaaaa",
      candidateId: "manual_aaaaaaaaaaaaaaaaaaaaaaaa",
      runId: "manual_20260806",
      title: "Manual research topic",
      summary: "Unresearched",
      recommendedAngle: "",
      score: null,
      selectionReasons: ["manually submitted"],
      evidenceStrength: "unresearched",
      sourceItemIds: [],
      primarySourceItemIds: [],
      submittedAt: now,
      submittedByUserId: "1",
      submittedInChatId: "1",
    };
    const queue = topicQueueItemSchema.parse({
      id: "queue_aaaaaaaaaaaaaaaaaaaaaaaa",
      shortId: "aaaaaaaaaaaa",
      topicId: candidate.id,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      candidateSnapshot: { kind: "manual_topic", candidate },
      approvalStatus: "approved",
      researchReadiness: "ready_for_research",
      editorialNotes: [],
      requestedAngle: "",
      origin: "manual_topic",
      triggerState: "topic_approved_event_created",
      createdAt: now,
      updatedAt: now,
      version: 2,
    });
    await telegram.saveQueueItem(queue);
    const event = topicApprovedEventSchema.parse({
      id: "event_aaaaaaaaaaaaaaaaaaaaaaaa",
      topicId: candidate.id,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      approvedAt: now,
      approvedBy: { telegramUserId: "1", telegramChatId: "1" },
      approvedAngle: "",
      editorialNotes: [],
      sourceItemIds: [],
      origin: "manual_topic",
      status: "ready",
      consumed: false,
      version: 1,
    });
    await telegram.saveApprovedEvent(event);
    const eventPath = join(
      root,
      "events",
      "topic-approved",
      `${event.id}.json`,
    );
    const before = await readFile(eventPath, "utf8");
    const repository = new FileApprovedEventRepository(
      join(root, "events", "topic-approved"),
      telegramRoot,
      join(root, "research"),
    );
    expect((await repository.next())?.id).toBe(event.id);
    await repository.consume(
      event.id,
      "packet_aaaaaaaaaaaaaaaaaaaaaaaa",
      1,
      now,
    );
    expect(await repository.isConsumed(event.id)).toBe(true);
    expect(await readFile(eventPath, "utf8")).toBe(before);
    expect(await repository.next()).toBeUndefined();
  });
});

describe("approved event to assisted packet integration", () => {
  it("retries only a retrieval-blocked assistance packet into a new immutable version", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-retrieval-retry-"));
    const now = "2026-08-09T18:00:00.000Z";
    const item = createSourceItem({
      sourceId: "official",
      sourceName: "Official",
      sourceType: "rss",
      authority: "primary",
      title: "Public release",
      url: "https://public.example/changelog/item",
      summary: "A public release announcement.",
      publishedAt: now,
      retrievedAt: now,
      language: "en",
    });
    const event = {
      id: "event_cccccccccccccccccccccccc",
      topicId: "topic_cccccccccccccccccccccccc",
      candidateId: "topic_cccccccccccccccccccccccc",
      runId: "run_retry",
      approvedAt: now,
      approvedBy: { telegramUserId: "1", telegramChatId: "1" },
      approvedAngle: "Explain the release",
      editorialNotes: [],
      sourceItemIds: [item.id],
      origin: "ranked" as const,
      status: "ready" as const,
      consumed: false as const,
      version: 1,
    };
    const events: ApprovedEventRepository = {
      next: async () => event,
      get: async () => event,
      queue: async () =>
        ({
          approvalStatus: "approved",
          researchReadiness: "ready_for_research",
          candidateSnapshot: {
            kind: "ranked",
            candidate: { title: item.title },
          },
        }) as never,
      isCancelled: async () => false,
      isConsumed: async () => false,
      consume: async () => undefined,
    };
    const packets = new FileResearchPacketRepository(root);
    const sources = new FileResearchSourceRepository(root);
    let retrievalAvailable = false;
    const service = new ResearchService({
      events,
      jobs: new FileResearchJobRepository(root),
      packets,
      sources,
      cache: sources,
      catalog: {
        latestRunId: async () => "run_retry",
        getRun: async () => ({
          runId: "run_retry",
          candidates: [],
          clusters: [],
          sourceItems: [item],
        }),
      },
      config: researchConfigSchema.parse({ mode: "assisted" }),
      now: () => new Date(now),
      lookup: async () => ["192.0.66.2", "::ffff:192.0.66.2"],
      fetch: async (url) => {
        if (url.endsWith("/robots.txt"))
          return new Response("User-agent: *\nAllow: /", {
            headers: { "content-type": "text/plain" },
          });
        if (!retrievalAvailable) throw new Error("temporary retrieval failure");
        return new Response(
          "<html><title>Public release</title><body><p>The public release is available today for developers.</p><p>The release adds documented usage metrics for agent activity.</p><p>The API reports activity from supported agent applications.</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      },
    });

    const first = await service.process(event.id);
    expect(first?.version).toBe(1);
    expect(first?.sourceIndex[0]?.extractionStatus).toBe("blocked");
    const versionOne = await packets.get(event.topicId, 1);

    retrievalAvailable = true;
    const retried = await service.retry(event.id);
    expect(retried?.version).toBe(2);
    expect(retried?.sourceIndex[0]?.extractionStatus).toBe("extracted");
    expect(await packets.get(event.topicId, 1)).toEqual(versionOne);
    expect(await packets.get(event.topicId)).toEqual(retried);
    await expect(service.retry(event.id)).rejects.toThrow(
      /failed or retrieval-blocked/,
    );
  });

  it("persists before consumption and replay creates no duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-flow-"));
    const now = "2026-08-06T12:00:00.000Z";
    const items = [
      ["official", "primary"],
      ["technical", "independent"],
      ["release", "independent"],
    ].map(([name, authority], index) =>
      createSourceItem({
        sourceId: name as string,
        sourceName: name as string,
        sourceType: "rss",
        authority: authority as "primary" | "independent",
        title: `Widget source ${index + 1}`,
        url: `https://${name}.example/article`,
        summary: "Widget 2 is available with 16 GB memory.",
        publishedAt: now,
        retrievedAt: now,
        language: "en",
      }),
    );
    const event = {
      id: "event_aaaaaaaaaaaaaaaaaaaaaaaa",
      topicId: "topic_aaaaaaaaaaaaaaaaaaaaaaaa",
      candidateId: "topic_aaaaaaaaaaaaaaaaaaaaaaaa",
      runId: "run_fixture",
      approvedAt: now,
      approvedBy: { telegramUserId: "1", telegramChatId: "1" },
      approvedAngle: "Why offline matters",
      editorialNotes: [],
      sourceItemIds: items.map((x) => x.id),
      origin: "ranked" as const,
      status: "ready" as const,
      consumed: false as const,
      version: 1,
    };
    let consumed = false;
    const events: ApprovedEventRepository = {
      next: async () => (consumed ? undefined : event),
      get: async (id) => (id === event.id ? event : undefined),
      queue: async () =>
        ({
          approvalStatus: "approved",
          researchReadiness: "ready_for_research",
          candidateSnapshot: {
            kind: "ranked",
            candidate: { title: "Widget 2" },
          },
        }) as never,
      isCancelled: async () => false,
      isConsumed: async () => consumed,
      consume: async () => {
        consumed = true;
      },
    };
    const packets = new FileResearchPacketRepository(root);
    const sourceRepo = new FileResearchSourceRepository(root);
    const service = new ResearchService({
      events,
      jobs: new FileResearchJobRepository(root),
      sources: sourceRepo,
      cache: sourceRepo,
      packets,
      catalog: {
        latestRunId: async () => "run_fixture",
        getRun: async () => ({
          runId: "run_fixture",
          candidates: [],
          clusters: [],
          sourceItems: items,
        }),
      },
      config: researchConfigSchema.parse({ mode: "assisted" }),
      now: () => new Date(now),
      lookup: async () => ["93.184.216.34"],
      fetch: async (url) =>
        url.endsWith("robots.txt")
          ? new Response("User-agent: *\nAllow: /", {
              headers: { "content-type": "text/plain" },
            })
          : new Response(
              "<html><title>Widget 2</title><body><p>Widget 2 is available with 16 GB memory today.</p><p>The product supports offline operation for developers.</p></body></html>",
              { headers: { "content-type": "text/html" } },
            ),
    });
    const first = await service.next();
    expect(first?.status).toBe("awaiting_assisted_synthesis");
    expect(consumed).toBe(false);
    const source = first?.sourceIndex[0];
    if (!first || !source?.selectedExcerpts[0])
      throw new Error("fixture failed");
    const taskDir = await writeAssistanceTask(
      first,
      join(root, "tasks"),
      "prompts/research-synthesis.md",
    );
    await expect(
      readFile(join(taskDir, "research-assistance.md"), "utf8"),
    ).resolves.toContain("No model is invoked");
    await expect(
      readFile(join(taskDir, "research-input.json"), "utf8"),
    ).resolves.toContain(first.topicId);
    await expect(
      readFile(join(taskDir, "expected-output.schema.json"), "utf8"),
    ).resolves.toContain("AssistedResearchResult");
    const resultPath = join(root, "result.json");
    const result = {
      schemaVersion: "1.0",
      topicId: first.topicId,
      approvedEventId: first.approvedEventId,
      sourcePacketVersion: first.version,
      executiveSummary:
        "The evidence supports an offline-focused launch analysis.",
      interpretations: [
        {
          id: "claim_bbbbbbbbbbbbbbbbbbbbbbbb",
          topicId: first.topicId,
          statement: "Offline support may reduce dependence on connectivity.",
          normalizedStatement:
            "offline support may reduce dependence on connectivity",
          claimType: "interpretation",
          sourceIds: [source.id],
          supportingExcerptIds: [source.selectedExcerpts[0].id],
          confidence: 0.7,
          status: "partially_supported",
          disagreementSourceIds: [],
          notes: ["Manual synthesis"],
          createdAt: now,
        },
      ],
      predictions: [],
      counterpoints: [],
      unknowns: [],
      recommendedThesis: "Offline support is the practical differentiator.",
      recommendedArticleType: "news_analysis",
      recommendedStructure: ["What changed", "Why it matters"],
    } as const;
    await writeAtomicJson(resultPath, result);
    const versionOne = await packets.get(first.topicId, 1);
    const imports = new FileAssistedResearchImportRepository(packets, events);
    const imported = await importAssistance(
      resultPath,
      packets,
      events,
      now,
      imports,
    );
    expect(imported.status).toBe("ready");
    expect(imported.interpretations).toEqual(
      expect.arrayContaining([...result.interpretations]),
    );
    expect(imported.version).toBe(2);
    expect(imported.id).toBe(first.id);
    expect(await packets.get(first.topicId, 1)).toEqual(versionOne);
    expect(await packets.get(first.topicId)).toEqual(imported);
    expect(consumed).toBe(true);
    expect(
      (await importAssistance(resultPath, packets, events, now, imports))
        .version,
    ).toBe(2);
    await writeAtomicJson(resultPath, {
      ...result,
      executiveSummary: "A revised evidence-backed offline launch analysis.",
    });
    const revised = await importAssistance(
      resultPath,
      packets,
      events,
      now,
      imports,
    );
    expect(revised.version).toBe(3);
    expect(revised.id).toBe(first.id);
    expect(await packets.get(first.topicId, 1)).toEqual(versionOne);
    expect(await packets.get(first.topicId)).toEqual(revised);
    expect(await service.process(event.id)).toBeUndefined();
    expect(await packets.nextVersion(event.topicId)).toBe(4);
  });
});
