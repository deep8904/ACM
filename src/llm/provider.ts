import { createHash } from "node:crypto";
import { z } from "zod";

import type { DatabaseClient } from "../database/client";

export type LlmStage = "research" | "writing" | "editorial_review" | "revision";

export interface LlmGeneration<T> {
  value: T;
  provider: string;
  model: string;
  providerVersion?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  responseHash: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(input: {
    jobId: string;
    stage: LlmStage;
    system: string;
    task: unknown;
    schema: z.ZodType<T>;
  }): Promise<LlmGeneration<T>>;
}

export class LlmProviderConfigurationError extends Error {
  readonly code = "llm_provider_configuration_invalid";

  constructor(message: string) {
    super(message);
    this.name = "LlmProviderConfigurationError";
  }
}

const geminiEnvelopeSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(z.object({ text: z.string().optional() })),
        }),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      totalTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  modelVersion: z.string().optional(),
});

export class GeminiLLMProvider implements LLMProvider {
  readonly name = "google_gemini";
  readonly model: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      sql?: DatabaseClient;
      fetch?: typeof fetch;
      maximumAttempts?: number;
    },
  ) {
    if (!options.apiKey) throw new Error("GOOGLE_AI_API_KEY is required");
    this.model = options.model.replace(/^models\//, "");
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async generate<T>(input: {
    jobId: string;
    stage: LlmStage;
    system: string;
    task: unknown;
    schema: z.ZodType<T>;
  }): Promise<LlmGeneration<T>> {
    const requestText = `${input.system.trim()}\n\nReturn exactly one JSON object and no markdown. The JSON must satisfy the supplied task identity and schema. Never invent source IDs, claim IDs, measurements, first-hand experience, or unsupported facts.\n\nTASK INPUT:\n${JSON.stringify(input.task, null, 2)}`;
    const requestHash = sha256(requestText);
    const callId = `llmcall_${sha256(`${input.jobId}:${input.stage}:${requestHash}`).slice(0, 24)}`;
    await this.recordStart(callId, input, requestHash);
    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= (this.options.maximumAttempts ?? 3);
      attempt += 1
    ) {
      try {
        const response = await this.fetchImplementation(
          geminiGenerateContentUrl(this.model, this.options.apiKey),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: requestText }] }],
              generationConfig: {
                responseMimeType: "application/json",
                temperature:
                  input.stage === "writing" || input.stage === "revision"
                    ? 0.35
                    : 0.1,
                maxOutputTokens:
                  input.stage === "writing" || input.stage === "revision"
                    ? 16384
                    : 8192,
              },
            }),
          },
        );
        if (!response.ok) {
          const retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500;
          if (retryable && attempt < (this.options.maximumAttempts ?? 3))
            continue;
          const detail = await safeGeminiError(response);
          const message = `Gemini request failed (${response.status}${detail ? ` ${detail}` : ""})`;
          if ([400, 401, 403, 404].includes(response.status))
            throw new LlmProviderConfigurationError(message);
          throw new Error(message);
        }
        const envelope = geminiEnvelopeSchema.parse(await response.json());
        const text = envelope.candidates?.[0]?.content.parts
          .map((part) => part.text ?? "")
          .join("")
          .trim();
        if (!text) throw new Error("Gemini returned no structured output");
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFence(text));
        } catch {
          throw new Error("Gemini returned invalid JSON");
        }
        const result = input.schema.safeParse(parsed);
        if (!result.success) {
          await this.recordFailure(
            callId,
            "schema_rejected",
            result.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          );
          if (attempt < (this.options.maximumAttempts ?? 3)) continue;
          throw new Error(
            `LLM structured output failed validation: ${result.error.issues[0]?.message ?? "unknown schema error"}`,
          );
        }
        const usage = envelope.usageMetadata
          ? {
              promptTokens: envelope.usageMetadata.promptTokenCount,
              completionTokens: envelope.usageMetadata.candidatesTokenCount,
              totalTokens: envelope.usageMetadata.totalTokenCount,
            }
          : undefined;
        const responseHash = sha256(JSON.stringify(result.data));
        await this.recordSuccess(
          callId,
          responseHash,
          envelope.modelVersion,
          usage,
        );
        return {
          value: result.data,
          provider: this.name,
          model: this.model,
          providerVersion: envelope.modelVersion,
          usage,
          responseHash,
        };
      } catch (error) {
        lastError = error;
        if (attempt < (this.options.maximumAttempts ?? 3) && transient(error))
          continue;
      }
    }
    await this.recordFailure(callId, "failed", safeError(lastError));
    throw lastError instanceof Error
      ? lastError
      : new Error("LLM generation failed");
  }

  private async recordStart(
    id: string,
    input: { jobId: string; stage: LlmStage },
    requestHash: string,
  ) {
    if (!this.options.sql) return;
    await this.options.sql`
      insert into content_machine.llm_invocations(id,job_id,stage,provider,model,request_hash,status)
      values (${id},${input.jobId},${input.stage},${this.name},${this.model},${requestHash},'started')
      on conflict(id) do update set status='started',error_summary=null,completed_at=null
    `;
  }

  private async recordSuccess(
    id: string,
    responseHash: string,
    providerVersion: string | undefined,
    usage: LlmGeneration<unknown>["usage"],
  ) {
    if (!this.options.sql) return;
    await this.options.sql`
      update content_machine.llm_invocations set status='succeeded',response_hash=${responseHash},
        provider_version=${providerVersion ?? null},prompt_tokens=${usage?.promptTokens ?? null},
        completion_tokens=${usage?.completionTokens ?? null},total_tokens=${usage?.totalTokens ?? null},completed_at=now()
      where id=${id}
    `;
  }

  private async recordFailure(
    id: string,
    status: "failed" | "schema_rejected",
    summary: string,
  ) {
    if (!this.options.sql) return;
    await this.options.sql`
      update content_machine.llm_invocations set status=${status},error_summary=${summary.slice(0, 1000)},completed_at=now()
      where id=${id}
    `;
  }
}

export function geminiGenerateContentUrl(model: string, apiKey: string) {
  const canonicalModel = model.replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(canonicalModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

export function createConfiguredLlmProvider(
  environment: NodeJS.ProcessEnv,
  sql?: DatabaseClient,
): LLMProvider {
  const provider = environment.LLM_PROVIDER ?? "gemini";
  if (provider !== "gemini")
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  return new GeminiLLMProvider({
    apiKey: environment.GOOGLE_AI_API_KEY ?? "",
    model: environment.GOOGLE_AI_MODEL ?? "gemini-2.5-flash",
    sql,
  });
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function transient(error: unknown) {
  return (
    error instanceof TypeError ||
    /(?:timeout|429|5\d\d|temporar|network)/i.test(safeError(error))
  );
}

function safeError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/(?:key|token|secret)=[^\s&]+/gi, "$1=<redacted>")
    : "Unknown provider failure";
}

async function safeGeminiError(response: Response): Promise<string> {
  const body = await response
    .clone()
    .json()
    .catch(() => undefined);
  const parsed = z
    .object({
      error: z
        .object({
          status: z.string().max(100).optional(),
          message: z.string().max(1000).optional(),
        })
        .optional(),
    })
    .safeParse(body);
  if (!parsed.success || !parsed.data.error) return "";
  const status = parsed.data.error.status?.replace(/[^A-Z0-9_]/g, "");
  const message = parsed.data.error.message
    ?.replace(/(?:key|token|secret)=[^\s&]+/gi, "$1=<redacted>")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "<redacted API key>")
    .slice(0, 500);
  return [status, message].filter(Boolean).join(": ");
}
