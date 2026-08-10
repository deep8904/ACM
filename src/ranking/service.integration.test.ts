import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  WorkflowArtifact,
  WorkflowArtifactRepository,
} from "../database/artifacts";
import { FileWorkflowArtifactRepository } from "../database/artifacts";
import { loadRankingConfig } from "./config";
import { FileHistoryRepository } from "./history";
import { runRankingPipeline } from "./service";

describe("ranking pipeline integration", () => {
  it("clusters, scores, suppresses, persists, and reuses stable offline outputs", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "ai-content-ranking-"));
    const artifacts = new FileWorkflowArtifactRepository(outputRoot);
    await artifacts.save({
      runId: "run_ranking_fixture",
      stage: "discovery",
      name: "normalized-items.json",
      mediaType: "application/json",
      content: JSON.parse(
        await readFile("data/samples/ranking-normalized-items.json", "utf8"),
      ) as unknown,
    });
    const options = {
      runId: "run_ranking_fixture",
      artifactRepository: artifacts,
      config: await loadRankingConfig(
        resolve("automation/config/ranking.example.yaml"),
      ),
      history: new FileHistoryRepository(
        resolve("data/samples/ranking-history.json"),
      ),
      now: () => new Date("2026-08-06T20:00:00.000Z"),
      monotonicNow: () => 100,
      logger: () => undefined,
    } as const;

    const first = await runRankingPipeline(options);
    const before = await artifactContents(first.outputDirectory);
    const second = await runRankingPipeline(options);
    const after = await artifactContents(second.outputDirectory);

    expect(after).toEqual(before);
    expect(second.report.inputItemCount).toBe(10);
    const gptApi = second.clusters.find(({ sourceItemIds }) =>
      sourceItemIds.includes("item_gpt5_official"),
    );
    expect(gptApi?.sourceItemIds).toEqual(
      expect.arrayContaining([
        "item_gpt5_official",
        "item_gpt5_news_one",
        "item_gpt5_news_two",
        "item_gpt5_hn",
      ]),
    );
    const mini = second.clusters.find(({ sourceItemIds }) =>
      sourceItemIds.includes("item_gpt5_mini"),
    );
    expect(mini?.id).not.toBe(gptApi?.id);
    const rumor = second.candidates.find(({ sourceItemIds }) =>
      sourceItemIds.includes("item_rtx_rumor"),
    );
    expect(rumor?.penalties.rumorRisk).toBeLessThan(0);
    const covered = second.candidates.find(({ sourceItemIds }) =>
      sourceItemIds.includes("item_figma_launch_primary"),
    );
    const followUp = second.candidates.find(({ sourceItemIds }) =>
      sourceItemIds.includes("item_figma_security_update"),
    );
    expect(covered?.status).toBe("suppressed");
    expect(followUp?.status).not.toBe("suppressed");
    expect(followUp?.selectionReasons.join(" ")).toMatch(
      /meaningful update override/,
    );
    expect(followUp?.rejectionReasons).toEqual([]);
    expect(second.aiPacket.length).toBeLessThanOrEqual(20);
  });

  it("reads discovery and persists ranking through the durable artifact repository", async () => {
    const artifacts = new MemoryArtifactRepository();
    const runId = "run_durable_ranking";
    await artifacts.save({
      runId,
      stage: "discovery",
      name: "normalized-items.json",
      mediaType: "application/json",
      content: JSON.parse(
        await readFile("data/samples/ranking-normalized-items.json", "utf8"),
      ) as unknown,
    });
    const options = {
      runId,
      config: await loadRankingConfig(
        resolve("automation/config/ranking.example.yaml"),
      ),
      history: new FileHistoryRepository(
        resolve("data/samples/ranking-history.json"),
      ),
      artifactRepository: artifacts,
      now: () => new Date("2026-08-06T20:00:00.000Z"),
      monotonicNow: () => 100,
      logger: () => undefined,
    } as const;

    const first = await runRankingPipeline(options);
    const second = await runRankingPipeline(options);

    expect(first.outputDirectory).toMatch(/^database:/);
    expect(second.ranked).toEqual(first.ranked);
    expect(
      await artifacts.get(runId, "ranking", "ranking-report.json"),
    ).toBeDefined();
  });
});

class MemoryArtifactRepository implements WorkflowArtifactRepository {
  private values = new Map<string, WorkflowArtifact>();

  async save(artifact: Omit<WorkflowArtifact, "contentHash">) {
    const key = this.key(artifact.runId, artifact.stage, artifact.name);
    if (this.values.has(key)) return false;
    this.values.set(key, { ...artifact, contentHash: "test-hash" });
    return true;
  }

  async get(runId: string, stage: WorkflowArtifact["stage"], name: string) {
    return this.values.get(this.key(runId, stage, name));
  }

  location(runId: string, stage: WorkflowArtifact["stage"]) {
    return `database:content_machine.workflow_artifacts/${runId}/${stage}`;
  }

  private key(runId: string, stage: string, name: string) {
    return `${runId}:${stage}:${name}`;
  }
}

async function artifactContents(directory: string): Promise<string[]> {
  return Promise.all(
    [
      "story-clusters.json",
      "topic-candidates.json",
      "ranked-topics.json",
      "suppressed-topics.json",
      "ranking-report.json",
      "ai-ranking-packet.json",
    ].map((file) => readFile(join(directory, file), "utf8")),
  );
}
