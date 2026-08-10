import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileWorkflowArtifactRepository } from "../artifacts";

describe("workflow artifact backend", () => {
  it("preserves the legacy layout behind the repository contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "content-artifacts-"));
    const repository = new FileWorkflowArtifactRepository(root);
    const artifact = {
      runId: "run_file_backend",
      stage: "discovery" as const,
      name: "normalized-items.json",
      mediaType: "application/json",
      content: [{ id: "item_1" }],
    };

    expect(await repository.save(artifact)).toBe(true);
    expect(await repository.save(artifact)).toBe(false);
    expect(
      await repository.get(artifact.runId, artifact.stage, artifact.name),
    ).toMatchObject({ content: artifact.content });
    expect(repository.location(artifact.runId, artifact.stage)).toBe(
      join(root, artifact.runId),
    );
  });

  it("rejects artifact path traversal", async () => {
    const repository = new FileWorkflowArtifactRepository("/tmp/artifacts");
    await expect(
      repository.save({
        runId: "run_safe",
        stage: "ranking",
        name: "../outside.json",
        mediaType: "application/json",
        content: {},
      }),
    ).rejects.toThrow(/Invalid artifact name/);
  });
});
