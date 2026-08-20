import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DatabaseClient } from "../database/client";
import {
  createConfiguredLlmProvider,
  FailoverAIProvider,
  GeminiAIProvider,
  GroqAIProvider,
  LlmProviderConfigurationError,
  OpenRouterAIProvider,
  resolveGroqModel,
  resolveGeminiModel,
} from "./provider";

const schema = z.object({ answer: z.literal("safe") }).strict();
const request = {
  jobId: `automationjob_${"a".repeat(24)}`,
  stage: "research" as const,
  system: "Return a test value.",
  task: {},
  schema,
};
const success = () =>
  Response.json({
    choices: [{ message: { content: '{"answer":"safe"}' } }],
    model: "resolved-model",
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
const geminiSuccess = () =>
  Response.json({
    candidates: [{ content: { parts: [{ text: '{"answer":"safe"}' }] } }],
    modelVersion: "gemini-test-001",
  });

describe("AI provider failover", () => {
  it("records Gemini quota failure and succeeds with Groq", async () => {
    const gemini = new GeminiAIProvider({
      apiKey: "gemini-key",
      model: "gemini-test",
      fetch: async () =>
        Response.json(
          {
            error: {
              status: "RESOURCE_EXHAUSTED",
              message: "Free tier quota exceeded",
            },
          },
          { status: 429 },
        ),
    });
    const groq = new GroqAIProvider({
      apiKey: "groq-key",
      model: "groq-test",
      fetch: async () => success(),
    });

    const result = await new FailoverAIProvider([gemini, groq]).summarize(
      request,
    );

    expect(result.provider).toBe("groq");
    expect(result.model).toBe("groq-test");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe("gemini_quota_exceeded");
    expect(result.attempts).toEqual([
      {
        provider: "gemini",
        model: "gemini-test",
        succeeded: false,
        failureReason: "gemini_quota_exceeded",
      },
      { provider: "groq", model: "groq-test", succeeded: true },
    ]);
  });

  it("writes provider, model, failure reason, and fallback reason to the audit log", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const gemini = new GeminiAIProvider({
      apiKey: "gemini-key",
      model: "gemini-test",
      fetch: async () =>
        Response.json(
          { error: { message: "quota exceeded" } },
          { status: 429 },
        ),
    });
    const groq = new GroqAIProvider({
      apiKey: "groq-key",
      model: "groq-test",
      fetch: async () => success(),
    });

    await new FailoverAIProvider([gemini, groq], sql).generate(request);

    expect(
      calls.some(
        (call) =>
          call.text.includes("failure_reason") &&
          call.values.includes("gemini_quota_exceeded"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.text.includes("fallback_reason") &&
          call.values.includes("groq") &&
          call.values.includes("groq-test") &&
          call.values.includes("gemini_quota_exceeded"),
      ),
    ).toBe(true);
  });

  it("falls back from Groq unavailability to OpenRouter", async () => {
    const groq = new GroqAIProvider({
      apiKey: "groq-key",
      model: "groq-test",
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    const openrouter = new OpenRouterAIProvider({
      apiKey: "openrouter-key",
      model: "openrouter-test",
      fetch: async () => success(),
    });

    const result = await new FailoverAIProvider([groq, openrouter]).generate(
      request,
    );

    expect(result.provider).toBe("openrouter");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe("groq_unavailable");
  });

  it("falls back when Groq reports token-per-minute exhaustion as HTTP 413", async () => {
    let groqCalls = 0;
    const groq = new GroqAIProvider({
      apiKey: "groq-key",
      model: "openai/gpt-oss-120b",
      fetch: async (input) => {
        groqCalls += 1;
        if (String(input).includes("/models/"))
          return Response.json({ id: "openai/gpt-oss-120b", active: true });
        return Response.json(
          {
            error: {
              message:
                "Request too large for model in organization on tokens per minute (TPM): Limit 8000, Requested 16541",
            },
          },
          { status: 413 },
        );
      },
    });
    const openrouter = new OpenRouterAIProvider({
      apiKey: "openrouter-key",
      model: "openrouter-test",
      fetch: async () => success(),
    });

    const result = await new FailoverAIProvider([groq, openrouter]).generate(
      request,
    );

    expect(groqCalls).toBe(2);
    expect(result.provider).toBe("openrouter");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe("groq_quota_exceeded");
    expect(result.attempts).toEqual([
      {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        succeeded: false,
        failureReason: "groq_quota_exceeded",
      },
      { provider: "openrouter", model: "openrouter-test", succeeded: true },
    ]);
  });

  it("falls back before generation when the configured Groq model is inaccessible", async () => {
    let groqCalls = 0;
    const groq = new GroqAIProvider({
      apiKey: "groq-key",
      model: "openai/gpt-oss-120b",
      fetch: async () => {
        groqCalls += 1;
        return Response.json(
          { error: { message: "model does not exist" } },
          { status: 404 },
        );
      },
    });
    const openrouter = new OpenRouterAIProvider({
      apiKey: "openrouter-key",
      model: "openrouter-test",
      fetch: async () => success(),
    });

    const result = await new FailoverAIProvider([groq, openrouter]).generate(
      request,
    );

    expect(groqCalls).toBe(1);
    expect(result.provider).toBe("openrouter");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe("groq_model_unavailable");
  });

  it("reports every failure when all providers are unavailable", async () => {
    const providers = [
      new GroqAIProvider({
        apiKey: "g",
        model: "g",
        fetch: async () => new Response("busy", { status: 503 }),
      }),
      new OpenRouterAIProvider({
        apiKey: "o",
        model: "o",
        fetch: async () => new Response("busy", { status: 429 }),
      }),
      new GeminiAIProvider({
        apiKey: "m",
        model: "m",
        fetch: async () => new Response("busy", { status: 503 }),
      }),
    ];

    await expect(
      new FailoverAIProvider(providers).generate(request),
    ).rejects.toMatchObject({
      name: "AllAIProvidersFailedError",
      attempts: expect.arrayContaining([
        expect.objectContaining({
          provider: "groq",
          failureReason: "groq_unavailable",
        }),
        expect.objectContaining({
          provider: "openrouter",
          failureReason: "openrouter_rate_limited",
        }),
        expect.objectContaining({
          provider: "gemini",
          failureReason: "gemini_unavailable",
        }),
      ]),
    });
  });

  it("does not fail over on schema-invalid content", async () => {
    let fallbackCalls = 0;
    const groq = new GroqAIProvider({
      apiKey: "g",
      model: "g",
      fetch: async () =>
        Response.json({
          choices: [{ message: { content: '{"answer":"unsafe"}' } }],
        }),
    });
    const openrouter = new OpenRouterAIProvider({
      apiKey: "o",
      model: "o",
      fetch: async () => {
        fallbackCalls += 1;
        return success();
      },
    });

    await expect(
      new FailoverAIProvider([groq, openrouter]).generate(request),
    ).rejects.toThrow("structured output failed validation");
    expect(fallbackCalls).toBe(0);
  });
});

describe("configured provider chain", () => {
  it("uses Groq, OpenRouter, then Gemini in production order", async () => {
    const provider = createConfiguredLlmProvider({
      NODE_ENV: "test",
      GROQ_API_KEY: "g",
      OPENROUTER_API_KEY: "o",
      GEMINI_API_KEY: "m",
    });
    expect(provider.name).toBe("provider_chain");
    expect(provider.model).toBe("openai/gpt-oss-120b");
  });

  it("rejects a retired Groq model before making a provider request", () => {
    expect(() =>
      createConfiguredLlmProvider({
        NODE_ENV: "test",
        GROQ_API_KEY: "g",
        GROQ_MODEL: "llama-3.3-70b-versatile",
      }),
    ).toThrow(
      'Unsupported GROQ_MODEL "llama-3.3-70b-versatile". Supported production models: openai/gpt-oss-120b, openai/gpt-oss-20b',
    );
  });

  it("validates exact Groq model access and uses it for every AI stage", async () => {
    const urls: string[] = [];
    const generationModels: string[] = [];
    const provider = new GroqAIProvider({
      apiKey: "groq-key",
      model: resolveGroqModel(undefined),
      fetch: async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/models/"))
          return Response.json({ id: "openai/gpt-oss-120b", active: true });
        generationModels.push(
          String((JSON.parse(String(init?.body)) as { model?: string }).model),
        );
        return success();
      },
    });

    await provider.summarize({ ...request, stage: "research" });
    await provider.generate({ ...request, stage: "writing" });
    await provider.review({ ...request, stage: "editorial_review" });
    await provider.generate({ ...request, stage: "revision" });

    expect(urls[0]).toBe(
      "https://api.groq.com/openai/v1/models/openai/gpt-oss-120b",
    );
    expect(generationModels).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
    ]);
  });

  it("returns a clear health diagnostic when the configured Groq model is inaccessible", async () => {
    const provider = new GroqAIProvider({
      apiKey: "groq-key",
      model: "openai/gpt-oss-120b",
      fetch: async () =>
        Response.json(
          { error: { message: "model does not exist" } },
          { status: 404 },
        ),
    });

    await expect(provider.healthCheck()).resolves.toMatchObject({
      available: false,
      failureReason: "groq_model_unavailable",
      diagnostic:
        'Groq model configuration invalid: model "openai/gpt-oss-120b" is unavailable or not accessible to this project',
    });
  });

  it("rejects an empty provider configuration", () => {
    expect(() => createConfiguredLlmProvider({ NODE_ENV: "test" })).toThrow(
      LlmProviderConfigurationError,
    );
  });

  it("keeps the legacy Gemini key as a migration bridge", () => {
    const provider = createConfiguredLlmProvider({
      NODE_ENV: "test",
      GOOGLE_AI_API_KEY: "legacy",
    });
    expect(provider.model).toBe("gemini-3.6-flash");
  });

  it("migrates the legacy Flash model name", () => {
    expect(resolveGeminiModel("models/gemini-2.5-flash")).toBe(
      "gemini-3.6-flash",
    );
  });

  it("preserves Gemini configuration diagnostics", async () => {
    const provider = new GeminiAIProvider({
      apiKey: "test-key",
      model: "missing-model",
      fetch: async () =>
        Response.json(
          { error: { status: "NOT_FOUND", message: "model not found" } },
          { status: 404 },
        ),
    });
    await expect(provider.generate(request)).rejects.toThrow(
      LlmProviderConfigurationError,
    );
  });

  it("validates Gemini structured output", async () => {
    const provider = new GeminiAIProvider({
      apiKey: "key",
      model: "model",
      fetch: async () => geminiSuccess(),
    });
    const result = await provider.review({
      ...request,
      stage: "editorial_review",
    });
    expect(result.value).toEqual({ answer: "safe" });
    expect(result.providerVersion).toBe("gemini-test-001");
  });
});
