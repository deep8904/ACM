import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  WorkflowArtifact,
  WorkflowArtifactRepository,
} from "../database/artifacts";
import { FileWorkflowArtifactRepository } from "../database/artifacts";
import type { TrendSourceAdapter } from "./adapters/types";
import { sourceConfigFileSchema } from "./config/source-config";
import { createSourceItem } from "./models/source-item";
import { runDiscovery } from "./discovery-service";

const retrievedAt = "2026-08-06T14:00:00.000Z";

describe("runDiscovery", () => {
  it("continues after a source fails, skips disabled sources, and overwrites idempotently", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "ai-content-discovery-"));
    const fetchSpy = vi.fn();
    let adapterCalls = 0;
    const adapter: TrendSourceAdapter = {
      supportedTypes: ["rss"],
      async fetchItems(source) {
        adapterCalls += 1;
        if (source.id === "failing-source") throw new Error("fixture failure");
        return {
          items: [
            createSourceItem({
              sourceId: source.id,
              sourceName: source.name,
              sourceType: source.type,
              authority: source.authority,
              sourceItemId: "stable-one",
              title: "Stable fixture",
              url: "https://example.com/stable",
              retrievedAt,
              language: "en",
            }),
          ],
          warnings: [],
        };
      },
    };
    const config = sourceConfigFileSchema.parse({
      sources: [
        source("working-source", true),
        source("failing-source", true),
        source("disabled-source", false),
      ],
    });
    const options = {
      runId: "run_test_idempotent",
      config,
      adapters: [adapter],
      fetch: fetchSpy,
      artifactRepository: new FileWorkflowArtifactRepository(outputRoot),
      now: () => new Date(retrievedAt),
      monotonicNow: () => 100,
      logger: () => undefined,
    } as const;

    const first = await runDiscovery(options);
    const firstContent = await readFile(
      join(first.outputDirectory, "normalized-items.json"),
      "utf8",
    );
    const second = await runDiscovery(options);
    const secondContent = await readFile(
      join(second.outputDirectory, "normalized-items.json"),
      "utf8",
    );

    expect(secondContent).toBe(firstContent);
    expect(second.normalizedItems).toHaveLength(1);
    expect(second.report.sourceReports).toEqual([
      expect.objectContaining({
        sourceId: "working-source",
        status: "success",
        itemCount: 1,
      }),
      expect.objectContaining({
        sourceId: "failing-source",
        status: "failed",
        error: "fixture failure",
      }),
    ]);
    expect(
      second.report.sourceReports.some(
        ({ sourceId }) => sourceId === "disabled-source",
      ),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(adapterCalls).toBe(2);
  });

  it("persists and reuses artifacts through the durable repository", async () => {
    const artifacts = new MemoryArtifactRepository();
    let calls = 0;
    const adapter: TrendSourceAdapter = {
      supportedTypes: ["rss"],
      async fetchItems(source) {
        calls += 1;
        return {
          items: [
            createSourceItem({
              sourceId: source.id,
              sourceName: source.name,
              sourceType: source.type,
              authority: source.authority,
              sourceItemId: "durable-one",
              title: "Durable fixture",
              url: "https://example.com/durable",
              retrievedAt,
              language: "en",
            }),
          ],
          warnings: [],
        };
      },
    };
    const options = {
      runId: "run_durable_discovery",
      config: sourceConfigFileSchema.parse({
        sources: [source("durable-source", true)],
      }),
      adapters: [adapter],
      fetch: vi.fn(),
      artifactRepository: artifacts,
      now: () => new Date(retrievedAt),
      monotonicNow: () => 100,
      logger: () => undefined,
    } as const;

    const first = await runDiscovery(options);
    const second = await runDiscovery(options);

    expect(first.outputDirectory).toMatch(/^database:/);
    expect(second.normalizedItems).toEqual(first.normalizedItems);
    expect(calls).toBe(1);
    expect(
      await artifacts.get(options.runId, "discovery", "normalized-items.json"),
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

function source(id: string, enabled: boolean) {
  return {
    id,
    name: id,
    type: "rss" as const,
    url: `https://example.com/${id}.xml`,
    authority: "primary" as const,
    enabled,
  };
}
