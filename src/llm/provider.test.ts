import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createConfiguredLlmProvider,
  GeminiLLMProvider,
  LlmProviderConfigurationError,
} from "./provider";

describe("GeminiLLMProvider", () => {
  it("retries a transient response and validates structured JSON", async () => {
    let calls = 0;
    let requestUrl = "";
    const provider = new GeminiLLMProvider({
      apiKey: "test-key",
      model: "test-model",
      fetch: async (input) => {
        requestUrl = String(input);
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
    expect(requestUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent?key=test-key",
    );
    expect(result.value).toEqual({ answer: "safe" });
    expect(result.usage?.totalTokens).toBe(3);
  });

  it("uses the intended production model route without duplicating models/", async () => {
    let requestUrl = "";
    const provider = new GeminiLLMProvider({
      apiKey: "test-key",
      model: "models/gemini-2.5-flash",
      maximumAttempts: 1,
      fetch: async (input) => {
        requestUrl = String(input);
        return Response.json({
          candidates: [{ content: { parts: [{ text: '{"answer":"safe"}' }] } }],
          modelVersion: "gemini-2.5-flash-001",
        });
      },
    });
    const result = await provider.generate({
      jobId: `automationjob_${"c".repeat(24)}`,
      stage: "research",
      system: "Return a test value.",
      task: {},
      schema: z.object({ answer: z.literal("safe") }).strict(),
    });
    expect(requestUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test-key",
    );
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.providerVersion).toBe("gemini-2.5-flash-001");
  });

  it("defaults production to the supported Gemini 3.6 Flash model", () => {
    const provider = createConfiguredLlmProvider({
      GOOGLE_AI_API_KEY: "test-key",
      NODE_ENV: "test",
    });
    expect(provider.model).toBe("gemini-3.6-flash");
    expect(geminiUrl(provider.model)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=test-key",
    );
  });

  it("omits sampling parameters deprecated by Gemini 3.6 Flash", async () => {
    let requestBody: unknown;
    const provider = new GeminiLLMProvider({
      apiKey: "test-key",
      model: "gemini-3.6-flash",
      maximumAttempts: 1,
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          candidates: [{ content: { parts: [{ text: '{"answer":"safe"}' }] } }],
          modelVersion: "gemini-3.6-flash",
        });
      },
    });
    await provider.generate({
      jobId: `automationjob_${"f".repeat(24)}`,
      stage: "research",
      system: "Return a test value.",
      task: {},
      schema: z.object({ answer: z.literal("safe") }).strict(),
    });
    expect(requestBody).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    });
    expect(
      (requestBody as { generationConfig: Record<string, unknown> })
        .generationConfig,
    ).not.toHaveProperty("temperature");
  });

  it("preserves a safe Gemini 404 diagnostic as a configuration failure", async () => {
    const provider = new GeminiLLMProvider({
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      maximumAttempts: 1,
      fetch: async () =>
        Response.json(
          {
            error: {
              code: 404,
              status: "NOT_FOUND",
              message:
                "models/gemini-2.5-flash is not found for API version v1beta",
            },
          },
          { status: 404 },
        ),
    });
    await expect(
      provider.generate({
        jobId: `automationjob_${"d".repeat(24)}`,
        stage: "research",
        system: "Return a test value.",
        task: {},
        schema: z.object({ answer: z.literal("safe") }).strict(),
      }),
    ).rejects.toThrow(LlmProviderConfigurationError);
    await expect(
      provider.generate({
        jobId: `automationjob_${"e".repeat(24)}`,
        stage: "research",
        system: "Return a test value.",
        task: {},
        schema: z.object({ answer: z.literal("safe") }).strict(),
      }),
    ).rejects.toThrow(/404 NOT_FOUND.*not found for API version v1beta/);
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

function geminiUrl(model: string) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=test-key`;
}
