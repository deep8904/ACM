import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GeminiLLMProvider } from "./provider";

describe("GeminiLLMProvider", () => {
  it("retries a transient response and validates structured JSON", async () => {
    let calls = 0;
    const provider = new GeminiLLMProvider({
      apiKey: "test-key",
      model: "test-model",
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response("busy", { status: 429 });
        return Response.json({
          candidates: [{ content: { parts: [{ text: '{"answer":"safe"}' }] } }],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 1,
            totalTokenCount: 3,
          },
          modelVersion: "test-model-001",
        });
      },
    });
    const result = await provider.generate({
      jobId: `automationjob_${"a".repeat(24)}`,
      stage: "writing",
      system: "Return a test value.",
      task: {},
      schema: z.object({ answer: z.literal("safe") }).strict(),
    });
    expect(calls).toBe(2);
    expect(result.value).toEqual({ answer: "safe" });
    expect(result.usage?.totalTokens).toBe(3);
  });

  it("rejects output that never satisfies the schema", async () => {
    const provider = new GeminiLLMProvider({
      apiKey: "test-key",
      model: "test-model",
      maximumAttempts: 1,
      fetch: async () =>
        Response.json({
          candidates: [
            { content: { parts: [{ text: '{"answer":"unsafe"}' }] } },
          ],
        }),
    });
    await expect(
      provider.generate({
        jobId: `automationjob_${"b".repeat(24)}`,
        stage: "editorial_review",
        system: "Return a test value.",
        task: {},
        schema: z.object({ answer: z.literal("safe") }).strict(),
      }),
    ).rejects.toThrow("structured output failed validation");
  });
});
