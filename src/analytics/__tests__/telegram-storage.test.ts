import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordingTelegramAdapter } from "../../telegram/recording-adapter";
import type { TelegramActor } from "../../telegram/authorization";
import type { TelegramUpdate } from "../../telegram/models";
import { analyticsConfigSchema } from "../config";
import { editorialInsightSchema, performanceSnapshotSchema } from "../models";
import type { AnalyticsService } from "../service";
import {
  FileEditorialInsightRepository,
  FilePerformanceSnapshotRepository,
} from "../storage";
import { AnalyticsTelegramController } from "../telegram";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const actor: TelegramActor = { chatId: "42", userId: "7", chatType: "private" };
const message = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 1,
    chat: { id: 42, type: "private" },
    from: { id: 7, is_bot: false },
    text: "/analytics",
  },
} as TelegramUpdate;

describe("analytics Telegram", () => {
  it("renders bounded aggregate commands and records accept as consideration only", async () => {
    const config = analyticsConfigSchema.parse(
      parse(await readFile("automation/config/analytics.example.yaml", "utf8")),
    );
    const insight = editorialInsightSchema.parse({
      id: "insight_aaaaaaaaaaaaaaaaaaaaaaaa",
      category: "data_quality",
      scope: "all_publications",
      title: "Coverage is incomplete",
      observation: "Two providers have partial aggregate coverage.",
      evidence: ["sample 5"],
      confidence: "moderate",
      sampleSize: 5,
      recommendedAction: "Review future collection coverage.",
      limitations: ["No causal inference."],
      status: "review_recommended",
      dataQuality: "moderate",
      suggestedChange: null,
      experiment: null,
      createdAt: "2026-06-30T00:00:00.000Z",
      version: 1,
    });
    const service = {
      status: vi.fn().mockResolvedValue({
        sources: [{ status: "available" }],
        imports: 1,
        articleMetricRecords: 5,
        socialMetricRecords: 3,
        snapshots: 5,
        insights: 1,
        reports: 2,
        strategyMutationEnabled: false,
        dashboardEnabled: false,
      }),
      reports: vi.fn().mockResolvedValue([]),
      insights: vi.fn().mockResolvedValue([insight]),
      article: vi.fn().mockResolvedValue([]),
      social: vi.fn().mockResolvedValue([]),
      actOnInsight: vi.fn().mockResolvedValue({ configurationChanged: false }),
    } as unknown as AnalyticsService;
    const adapter = new RecordingTelegramAdapter();
    const controller = new AnalyticsTelegramController({
      service,
      publications: { list: async () => [] },
      adapter,
      callbackSecret: "secret-with-enough-entropy",
      config,
    });
    await controller.processCommand("/analytics", "", message, actor);
    await controller.processCommand("/editorial_insights", "", message, actor);
    const cardCall = adapter.calls.find(
      (call) => call.method === "sendFinalReviewCard",
    );
    expect(
      cardCall && cardCall.method === "sendFinalReviewCard"
        ? cardCall.card.text
        : "",
    ).not.toMatch(/user|session|cookie|telegram id/i);
    const callbackData =
      cardCall && cardCall.method === "sendFinalReviewCard"
        ? cardCall.card.buttons[0]![1]!.callbackData
        : "";
    await controller.processCallback(
      {
        update_id: 2,
        callback_query: {
          id: "cb",
          from: { id: 7, is_bot: false },
          message: message.message,
          data: callbackData,
        },
      } as TelegramUpdate,
      actor,
    );
    expect(service.actOnInsight).toHaveBeenCalledWith(
      insight.id,
      "accepted_for_consideration",
    );
    expect(
      adapter.calls.every(
        (call) =>
          !("text" in call) ||
          typeof call.text !== "string" ||
          call.text.length <= config.telegramSummaryCharacters,
      ),
    ).toBe(true);
  });
});

describe("analytics persistence", () => {
  it("writes immutable snapshots with mode 0600 and stable serialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "analytics-test-"));
    roots.push(root);
    const repository = new FilePerformanceSnapshotRepository(root);
    const snapshot = performanceSnapshotSchema.parse({
      id: "snapshot_aaaaaaaaaaaaaaaaaaaaaaaa",
      publicationId: "publication_111111111111111111111111",
      period: "7d",
      articleMetrics: [],
      socialMetrics: [],
      derivedMetrics: {
        searchCtr: null,
        socialClickThroughRate: null,
        engagementRate: null,
        viewsPerDay: null,
        clicksPerDay: null,
        impressionsPerDay: null,
        searchGrowthRate: null,
        trafficSourceConcentration: null,
        socialToSiteClickRatio: null,
        publicationVelocity: null,
        editorialCycleSeconds: null,
        revisionCount: null,
        sourceDiversity: null,
        searchLongevity: null,
        distributionCompletionRate: null,
        performanceIndex: null,
      },
      createdAt: "2026-06-30T00:00:00.000Z",
      contentHash: "a".repeat(64),
      warnings: ["Missing remains null"],
    });
    expect(await repository.save(snapshot)).toBe(true);
    expect(await repository.save(snapshot)).toBe(false);
    const path = join(root, "snapshots", snapshot.publicationId, "7d.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(snapshot);
  });

  it("persists versioned insight actions immutably", async () => {
    const root = await mkdtemp(join(tmpdir(), "analytics-test-"));
    roots.push(root);
    const repository = new FileEditorialInsightRepository(root);
    const action = {
      insightId: "insight_aaaaaaaaaaaaaaaaaaaaaaaa",
      action: "reviewed" as const,
      note: null,
      createdAt: "2026-06-30T00:00:00.000Z",
      version: 1,
    };
    await repository.action(action);
    await expect(repository.action(action)).rejects.toThrow(/version conflict/);
  });
});
