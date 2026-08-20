import { createHash } from "node:crypto";
import { z } from "zod";

import type { DatabaseClient } from "../database/client";

export type LlmStage = "research" | "writing" | "editorial_review" | "revision";
export interface AIProviderRequest<T> {
  jobId: string;
  stage: LlmStage;
  system: string;
  task: unknown;
  schema: z.ZodType<T>;
  normalizeOutput?: (value: unknown) => unknown;
}
export interface AIProviderAttempt {
  provider: string;
  model: string;
  succeeded: boolean;
  failureReason?: string;
}
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
  fallbackUsed: boolean;
  fallbackReason?: string;
  attempts: AIProviderAttempt[];
}
export interface AIProviderHealth {
  provider: string;
  model: string;
  available: boolean;
  failureReason?: string;
  diagnostic?: string;
}
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(input: AIProviderRequest<T>): Promise<LlmGeneration<T>>;
  summarize<T>(input: AIProviderRequest<T>): Promise<LlmGeneration<T>>;
  review<T>(input: AIProviderRequest<T>): Promise<LlmGeneration<T>>;
  healthCheck(): Promise<AIProviderHealth>;
}
export type LLMProvider = AIProvider;

export class LlmProviderConfigurationError extends Error {
  readonly code = "llm_provider_configuration_invalid";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmProviderConfigurationError";
  }
}
export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly reason: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
export class AllAIProvidersFailedError extends Error {
  readonly code = "all_ai_providers_failed";
  constructor(readonly attempts: AIProviderAttempt[]) {
    super(
      `All AI providers failed: ${attempts.map((attempt) => `${attempt.provider} (${attempt.failureReason ?? "unknown"})`).join(", ")}`,
    );
    this.name = "AllAIProvidersFailedError";
  }
}

abstract class StructuredAIProvider implements AIProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract generate<T>(input: AIProviderRequest<T>): Promise<LlmGeneration<T>>;
  summarize<T>(input: AIProviderRequest<T>) {
    return this.generate(input);
  }
  review<T>(input: AIProviderRequest<T>) {
    return this.generate(input);
  }
  abstract healthCheck(): Promise<AIProviderHealth>;
  protected result<T>(
    value: T,
    providerVersion?: string,
    usage?: LlmGeneration<T>["usage"],
  ): LlmGeneration<T> {
    return {
      value,
      provider: this.name,
      model: this.model,
      providerVersion,
      usage,
      responseHash: sha256(JSON.stringify(value)),
      fallbackUsed: false,
      attempts: [{ provider: this.name, model: this.model, succeeded: true }],
    };
  }
}

interface HttpProviderOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const GROQ_TPM_LIMIT = 8_000;
const GROQ_TPM_SAFETY_LIMIT = 7_500;
const MAX_MEDIUM_REQUEST_TOKENS = 16_000;
const COMPLETION_TOKEN_BUDGET: Record<LlmStage, number> = {
  research: 3_072,
  writing: 4_096,
  editorial_review: 1_536,
  revision: 4_096,
};

function completionTokenBudget(stage: LlmStage) {
  return COMPLETION_TOKEN_BUDGET[stage];
}

function estimatedPromptTokens(input: AIProviderRequest<unknown>) {
  const responseSchema = JSON.stringify(
    z.toJSONSchema(input.schema, { target: "draft-2020-12" }),
  );
  return Math.ceil(
    `${input.system}\n\n${requestText(input)}\n\n${responseSchema}`.length / 3 +
      64,
  );
}

export function estimateAIRequest(input: AIProviderRequest<unknown>) {
  const promptTokens = estimatedPromptTokens(input);
  const completionTokens = completionTokenBudget(input.stage);
  const totalTokens = promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    size:
      totalTokens <= GROQ_TPM_SAFETY_LIMIT
        ? ("small" as const)
        : totalTokens <= MAX_MEDIUM_REQUEST_TOKENS
          ? ("medium" as const)
          : ("large" as const),
  };
}

function jsonSchemaResponseFormat<T>(input: AIProviderRequest<T>) {
  const schema = z.toJSONSchema(input.schema, { target: "draft-2020-12" });
  delete schema.$schema;
  return {
    type: "json_schema",
    json_schema: {
      name: `acm_${input.stage}`,
      strict: false,
      schema,
    },
  };
}

const openAIEnvelopeSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullable() }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

abstract class OpenAICompatibleProvider extends StructuredAIProvider {
  readonly model: string;
  protected readonly fetchImplementation: typeof fetch;
  protected readonly timeoutMs: number;
  protected constructor(
    protected readonly options: HttpProviderOptions,
    private readonly endpoint: string,
  ) {
    super();
    if (!options.apiKey)
      throw new LlmProviderConfigurationError(
        `${this.constructor.name} API key is required`,
      );
    this.model = options.model;
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }
  async generate<T>(input: AIProviderRequest<T>): Promise<LlmGeneration<T>> {
    const maxTokens = completionTokenBudget(input.stage);
    const responseFormat = this.responseFormat(input);
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: this.userMessage(input) },
        ],
        ...(responseFormat ? { response_format: responseFormat } : {}),
        max_tokens: maxTokens,
        ...(this.model.startsWith("openai/gpt-oss-")
          ? { reasoning_effort: "low" }
          : {}),
        ...(this.name === "openrouter"
          ? {
              plugins: [{ id: "response-healing" }],
              provider: { require_parameters: true },
            }
          : {}),
      }),
    });
    const envelope = openAIEnvelopeSchema.parse(await response.json());
    const value = validateStructuredOutput(
      envelope.choices[0]?.message.content,
      input.schema,
      this.name,
      input.normalizeOutput,
    );
    return this.result(
      value,
      envelope.model,
      envelope.usage
        ? {
            promptTokens: envelope.usage.prompt_tokens,
            completionTokens: envelope.usage.completion_tokens,
            totalTokens: envelope.usage.total_tokens,
          }
        : undefined,
    );
  }
  async healthCheck(): Promise<AIProviderHealth> {
    try {
      await this.request(`${new URL(this.endpoint).origin}/openai/v1/models`, {
        headers: { authorization: `Bearer ${this.options.apiKey}` },
      });
      return { provider: this.name, model: this.model, available: true };
    } catch (error) {
      return healthFailure(this, error);
    }
  }
  protected async request(url: string, init: RequestInit) {
    try {
      const response = await this.fetchImplementation(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok)
        throw providerHttpError(
          this.name,
          response.status,
          await safeHttpError(response),
        );
      return response;
    } catch (error) {
      throw normalizeProviderError(this.name, error);
    }
  }
  protected userMessage<T>(input: AIProviderRequest<T>) {
    return requestText(input);
  }
  protected responseFormat<T>(
    input: AIProviderRequest<T>,
  ): Record<string, unknown> | undefined {
    return jsonSchemaResponseFormat(input);
  }
}

export class GroqAIProvider extends OpenAICompatibleProvider {
  readonly name = "groq";
  private modelValidation?: Promise<void>;

  constructor(options: HttpProviderOptions) {
    super(options, "https://api.groq.com/openai/v1/chat/completions");
  }

  override async generate<T>(
    input: AIProviderRequest<T>,
  ): Promise<LlmGeneration<T>> {
    const estimatedTotal =
      estimatedPromptTokens(input) + completionTokenBudget(input.stage);
    if (estimatedTotal > GROQ_TPM_SAFETY_LIMIT)
      throw new AIProviderError(
        `Groq request budget exceeds the ${GROQ_TPM_LIMIT} TPM limit (estimated ${estimatedTotal} tokens for ${input.stage}); using fallback provider before sending the request`,
        this.name,
        "groq_request_budget_exceeded",
        true,
      );
    await (this.modelValidation ??= this.validateModelAccess());
    return super.generate(input);
  }

  override async healthCheck(): Promise<AIProviderHealth> {
    try {
      await this.validateModelAccess();
      return { provider: this.name, model: this.model, available: true };
    } catch (error) {
      const normalized = normalizeProviderError(this.name, error);
      return {
        provider: this.name,
        model: this.model,
        available: false,
        failureReason: normalized.reason,
        diagnostic: normalized.message,
      };
    }
  }

  private async validateModelAccess() {
    try {
      await this.request(
        `https://api.groq.com/openai/v1/models/${this.model
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`,
        { headers: { authorization: `Bearer ${this.options.apiKey}` } },
      );
    } catch (error) {
      if (
        error instanceof LlmProviderConfigurationError &&
        error.status === 404
      )
        throw new AIProviderError(
          `Groq model configuration invalid: model "${this.model}" is unavailable or not accessible to this project`,
          this.name,
          "groq_model_unavailable",
          true,
          404,
        );
      throw error;
    }
  }
}
export class OpenRouterAIProvider extends OpenAICompatibleProvider {
  readonly name = "openrouter";
  constructor(options: HttpProviderOptions) {
    super(
      { ...options, timeoutMs: options.timeoutMs ?? 90_000 },
      "https://openrouter.ai/api/v1/chat/completions",
    );
  }
  override async healthCheck(): Promise<AIProviderHealth> {
    try {
      await this.request("https://openrouter.ai/api/v1/models", {
        headers: { authorization: `Bearer ${this.options.apiKey}` },
      });
      return { provider: this.name, model: this.model, available: true };
    } catch (error) {
      return healthFailure(this, error);
    }
  }
}

const BYTEZ_DEFAULT_MODEL = "unsloth/Qwen3-8B";
const bytezModelListSchema = z.object({
  error: z.unknown().nullable().optional(),
  output: z.array(z.object({ modelId: z.string() })),
});

export class BytezAIProvider extends OpenAICompatibleProvider {
  readonly name = "bytez";
  private modelValidation?: Promise<void>;

  constructor(options: HttpProviderOptions) {
    super(
      { ...options, timeoutMs: options.timeoutMs ?? 120_000 },
      "https://api.bytez.com/models/v2/openai/v1/chat/completions",
    );
  }

  override async generate<T>(
    input: AIProviderRequest<T>,
  ): Promise<LlmGeneration<T>> {
    await (this.modelValidation ??= this.validateModelAccess());
    return super.generate(input);
  }

  override async healthCheck(): Promise<AIProviderHealth> {
    try {
      await this.validateModelAccess();
      return { provider: this.name, model: this.model, available: true };
    } catch (error) {
      const normalized = normalizeProviderError(this.name, error);
      return {
        provider: this.name,
        model: this.model,
        available: false,
        failureReason: normalized.reason,
        diagnostic: normalized.message,
      };
    }
  }

  protected override userMessage<T>(input: AIProviderRequest<T>) {
    const schema = z.toJSONSchema(input.schema, { target: "draft-2020-12" });
    delete schema.$schema;
    return `${requestText(input)}\n\nOUTPUT JSON SCHEMA:\n${JSON.stringify(schema)}`;
  }

  protected override responseFormat(): undefined {
    return undefined;
  }

  private async validateModelAccess() {
    const response = await this.request(
      "https://api.bytez.com/models/v2/list/models?task=chat",
      { headers: { authorization: this.options.apiKey } },
    );
    const models = bytezModelListSchema.parse(await response.json());
    if (!models.output.some(({ modelId }) => modelId === this.model)) {
      const accessibleModels = models.output
        .slice(0, 5)
        .map(({ modelId }) => modelId)
        .join(", ");
      throw new AIProviderError(
        `Bytez model configuration invalid: model "${this.model}" is unavailable or not accessible to this project. Accessible chat models include: ${accessibleModels || "none returned"}`,
        this.name,
        "bytez_model_unavailable",
        true,
        404,
      );
    }
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
export class GeminiAIProvider extends StructuredAIProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  constructor(
    private readonly options: HttpProviderOptions & {
      maximumAttempts?: number;
    },
  ) {
    super();
    if (!options.apiKey)
      throw new LlmProviderConfigurationError("GEMINI_API_KEY is required");
    this.model = options.model.replace(/^models\//, "");
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }
  async generate<T>(input: AIProviderRequest<T>): Promise<LlmGeneration<T>> {
    try {
      const response = await this.fetchImplementation(
        geminiGenerateContentUrl(this.model, this.options.apiKey),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: `${input.system}\n\n${requestText(input)}` }],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              maxOutputTokens: completionTokenBudget(input.stage),
            },
          }),
        },
      );
      if (!response.ok) {
        const detail = await safeHttpError(response);
        if ([400, 401, 403, 404].includes(response.status))
          throw new LlmProviderConfigurationError(
            `Gemini request failed (${response.status}${detail ? ` ${detail}` : ""})`,
            response.status,
          );
        throw providerHttpError(this.name, response.status, detail);
      }
      const envelope = geminiEnvelopeSchema.parse(await response.json());
      const text = envelope.candidates?.[0]?.content.parts
        .map((part) => part.text ?? "")
        .join("");
      const value = validateStructuredOutput(
        text,
        input.schema,
        this.name,
        input.normalizeOutput,
      );
      return this.result(
        value,
        envelope.modelVersion,
        envelope.usageMetadata
          ? {
              promptTokens: envelope.usageMetadata.promptTokenCount,
              completionTokens: envelope.usageMetadata.candidatesTokenCount,
              totalTokens: envelope.usageMetadata.totalTokenCount,
            }
          : undefined,
      );
    } catch (error) {
      throw normalizeProviderError(this.name, error);
    }
  }
  async healthCheck(): Promise<AIProviderHealth> {
    try {
      const response = await this.fetchImplementation(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}?key=${encodeURIComponent(this.options.apiKey)}`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!response.ok)
        throw providerHttpError(
          this.name,
          response.status,
          await safeHttpError(response),
        );
      return { provider: this.name, model: this.model, available: true };
    } catch (error) {
      return healthFailure(this, normalizeProviderError(this.name, error));
    }
  }
}
export const GeminiLLMProvider = GeminiAIProvider;

export class FailoverAIProvider extends StructuredAIProvider {
  readonly name = "provider_chain";
  readonly model: string;
  constructor(
    private readonly providers: AIProvider[],
    private readonly sql?: DatabaseClient,
  ) {
    super();
    if (!providers.length)
      throw new LlmProviderConfigurationError(
        "No AI provider API keys are configured",
      );
    this.model = providers[0]!.model;
  }
  generate<T>(input: AIProviderRequest<T>) {
    return this.execute("generate", input);
  }
  summarize<T>(input: AIProviderRequest<T>) {
    return this.execute("summarize", input);
  }
  review<T>(input: AIProviderRequest<T>) {
    return this.execute("review", input);
  }
  async healthCheck(): Promise<AIProviderHealth> {
    const checks = await Promise.all(
      this.providers.map((provider) => provider.healthCheck()),
    );
    return (
      checks.find((check) => check.available) ?? {
        provider: this.name,
        model: this.model,
        available: false,
        failureReason: checks
          .map((check) => check.failureReason)
          .filter(Boolean)
          .join(","),
      }
    );
  }
  private async execute<T>(
    operation: "generate" | "summarize" | "review",
    input: AIProviderRequest<T>,
  ): Promise<LlmGeneration<T>> {
    const estimate = estimateAIRequest(input);
    if (estimate.size === "large")
      throw new AIProviderError(
        `AI request requires preparation before routing (estimated ${estimate.totalTokens} tokens exceeds the ${MAX_MEDIUM_REQUEST_TOKENS} token maximum)`,
        this.name,
        "llm_request_requires_compression",
        false,
      );
    const attempts: AIProviderAttempt[] = [];
    const requestHash = sha256(
      `${input.system.trim()}\n\n${requestText(input)}`,
    );
    for (const [index, provider] of this.providers.entries()) {
      const fallbackReason = attempts.at(-1)?.failureReason;
      const callId = `llmcall_${sha256(`${input.jobId}:${input.stage}:${requestHash}:${provider.name}:${index}`).slice(0, 24)}`;
      await this.recordStart(
        callId,
        input,
        provider,
        requestHash,
        index,
        fallbackReason,
      );
      try {
        const result = await provider[operation](input);
        attempts.push({
          provider: provider.name,
          model: provider.model,
          succeeded: true,
        });
        const final = {
          ...result,
          fallbackUsed: index > 0,
          fallbackReason,
          attempts,
        };
        await this.recordSuccess(callId, final);
        return final;
      } catch (error) {
        const normalized =
          error instanceof LlmProviderConfigurationError
            ? new AIProviderError(
                error.message,
                provider.name,
                `${provider.name}_configuration_invalid`,
                false,
              )
            : normalizeProviderError(provider.name, error);
        attempts.push({
          provider: provider.name,
          model: provider.model,
          succeeded: false,
          failureReason: normalized.reason,
        });
        await this.recordFailure(callId, normalized.reason, normalized.message);
        if (!normalized.retryable) throw normalized;
      }
    }
    throw new AllAIProvidersFailedError(attempts);
  }
  private async recordStart(
    id: string,
    input: Pick<AIProviderRequest<unknown>, "jobId" | "stage">,
    provider: AIProvider,
    requestHash: string,
    index: number,
    fallbackReason?: string,
  ) {
    if (!this.sql) return;
    await this.sql`insert into content_machine.llm_invocations
      (id,job_id,stage,provider,model,request_hash,status,attempt_index,fallback_used,fallback_reason)
      values (${id},${input.jobId},${input.stage},${provider.name},${provider.model},${requestHash},'started',${index + 1},${index > 0},${fallbackReason ?? null})
      on conflict(id) do update set status='started',failure_reason=null,error_summary=null,completed_at=null`;
  }
  private async recordSuccess<T>(id: string, result: LlmGeneration<T>) {
    if (!this.sql) return;
    await this
      .sql`update content_machine.llm_invocations set status='succeeded',response_hash=${result.responseHash}, provider_version=${result.providerVersion ?? null},
      prompt_tokens=${result.usage?.promptTokens ?? null},completion_tokens=${result.usage?.completionTokens ?? null},total_tokens=${result.usage?.totalTokens ?? null},completed_at=now() where id=${id}`;
  }
  private async recordFailure(id: string, reason: string, summary: string) {
    if (!this.sql) return;
    await this
      .sql`update content_machine.llm_invocations set status='failed',failure_reason=${reason},error_summary=${safeError(summary).slice(0, 1000)},completed_at=now() where id=${id}`;
  }
}

export function createConfiguredLlmProvider(
  environment: NodeJS.ProcessEnv,
  sql?: DatabaseClient,
): AIProvider {
  const providers: AIProvider[] = [];
  if (environment.GROQ_API_KEY)
    providers.push(
      new GroqAIProvider({
        apiKey: environment.GROQ_API_KEY,
        model: resolveGroqModel(environment.GROQ_MODEL),
      }),
    );
  if (environment.OPENROUTER_API_KEY)
    providers.push(
      new OpenRouterAIProvider({
        apiKey: environment.OPENROUTER_API_KEY,
        model: environment.OPENROUTER_MODEL ?? "openai/gpt-oss-120b",
      }),
    );
  const geminiKey = environment.GEMINI_API_KEY ?? environment.GOOGLE_AI_API_KEY;
  if (geminiKey)
    providers.push(
      new GeminiAIProvider({
        apiKey: geminiKey,
        model: resolveGeminiModel(
          environment.GEMINI_MODEL ?? environment.GOOGLE_AI_MODEL,
        ),
      }),
    );
  if (environment.BYTEZ_API_KEY)
    providers.push(
      new BytezAIProvider({
        apiKey: environment.BYTEZ_API_KEY,
        model: environment.BYTEZ_MODEL?.trim() || BYTEZ_DEFAULT_MODEL,
      }),
    );
  return new FailoverAIProvider(providers, sql);
}

export const GROQ_PRODUCTION_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
] as const;

export function resolveGroqModel(configuredModel: string | undefined) {
  const model = configuredModel?.trim() || "openai/gpt-oss-120b";
  if (!(GROQ_PRODUCTION_MODELS as readonly string[]).includes(model))
    throw new LlmProviderConfigurationError(
      `Unsupported GROQ_MODEL "${model}". Supported production models: ${GROQ_PRODUCTION_MODELS.join(", ")}`,
    );
  return model;
}

export function geminiGenerateContentUrl(model: string, apiKey: string) {
  const canonicalModel = model.replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(canonicalModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}
export function resolveGeminiModel(configuredModel: string | undefined) {
  const model = configuredModel?.replace(/^models\//, "");
  return !model || model === "gemini-2.5-flash" ? "gemini-3.6-flash" : model;
}
function requestText<T>(input: AIProviderRequest<T>) {
  return `Return exactly one JSON object and no markdown. The JSON must satisfy the supplied task identity and schema. Never invent source IDs, claim IDs, measurements, first-hand experience, or unsupported facts.\n\nTASK INPUT:\n${JSON.stringify(input.task, null, 2)}`;
}
function validateStructuredOutput<T>(
  text: string | null | undefined,
  schema: z.ZodType<T>,
  provider: string,
  normalizeOutput?: (value: unknown) => unknown,
) {
  if (!text?.trim())
    throw new AIProviderError(
      `${provider} returned no structured output`,
      provider,
      `${provider}_invalid_output`,
      true,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text.trim()));
  } catch {
    throw new AIProviderError(
      `${provider} returned invalid JSON`,
      provider,
      `${provider}_invalid_output`,
      true,
    );
  }
  let normalized = parsed;
  try {
    normalized = normalizeOutput ? normalizeOutput(parsed) : parsed;
  } catch (error) {
    const diagnostic =
      error instanceof z.ZodError
        ? `${error.issues[0]?.path.join(".") || "output"}: ${error.issues[0]?.message ?? "invalid normalized output"}`
        : safeError(error);
    throw new AIProviderError(
      `LLM structured output failed normalization: ${diagnostic}`,
      provider,
      `${provider}_schema_rejected`,
      true,
    );
  }
  const result = schema.safeParse(normalized);
  if (!result.success)
    throw new AIProviderError(
      `LLM structured output failed validation: ${result.error.issues[0]?.message ?? "unknown schema error"}`,
      provider,
      `${provider}_schema_rejected`,
      true,
    );
  return result.data;
}
function providerHttpError(provider: string, status: number, detail: string) {
  const quota =
    status === 402 ||
    /quota|resource_exhausted|insufficient.*credit|tokens per minute|\bTPM\b|rate limit|limit\s+\d[\d,]*\s*,?\s*requested/i.test(
      detail,
    );
  const timedOut = /timeout|timed out|deadline exceeded/i.test(detail);
  const unavailable = /unavailable|temporar(?:y|ily)|overloaded/i.test(detail);
  const reason = quota
    ? `${provider}_quota_exceeded`
    : timedOut
      ? `${provider}_timeout`
      : status === 429
        ? `${provider}_rate_limited`
        : status === 408
          ? `${provider}_timeout`
          : `${provider}_unavailable`;
  const retryable =
    quota ||
    timedOut ||
    unavailable ||
    status === 408 ||
    status === 429 ||
    status >= 500;
  const message = `${provider} request failed (${status}${detail ? ` ${detail}` : ""})`;
  return retryable
    ? new AIProviderError(message, provider, reason, true, status)
    : new LlmProviderConfigurationError(message, status);
}
function normalizeProviderError(
  provider: string,
  error: unknown,
): AIProviderError {
  if (error instanceof AIProviderError) return error;
  if (error instanceof LlmProviderConfigurationError) throw error;
  const message = safeError(error);
  const timeout =
    /timeout|abort/i.test(message) ||
    (error instanceof DOMException && error.name === "TimeoutError");
  if (timeout)
    return new AIProviderError(
      `${provider} request timed out`,
      provider,
      `${provider}_timeout`,
      true,
    );
  if (error instanceof TypeError)
    return new AIProviderError(
      `${provider} is unavailable`,
      provider,
      `${provider}_unavailable`,
      true,
    );
  return new AIProviderError(message, provider, `${provider}_failed`, false);
}
function healthFailure(
  provider: Pick<AIProvider, "name" | "model">,
  error: unknown,
): AIProviderHealth {
  const normalized =
    error instanceof LlmProviderConfigurationError
      ? new AIProviderError(
          error.message,
          provider.name,
          `${provider.name}_configuration_invalid`,
          false,
        )
      : normalizeProviderError(provider.name, error);
  return {
    provider: provider.name,
    model: provider.model,
    available: false,
    failureReason: normalized.reason,
    diagnostic: normalized.message,
  };
}
function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function safeError(error: unknown) {
  const value =
    error instanceof Error
      ? error.message
      : String(error || "Unknown provider failure");
  return value
    .replace(/(?:key|token|secret)=[^\s&]+/gi, "$1=<redacted>")
    .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "<redacted API key>");
}
async function safeHttpError(response: Response): Promise<string> {
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text) as {
      error?: { status?: unknown; message?: unknown } | string;
    };
    if (typeof body.error === "string")
      return safeError(body.error).slice(0, 500);
    return safeError(
      [body.error?.status, body.error?.message]
        .filter((value) => typeof value === "string")
        .join(": "),
    ).slice(0, 500);
  } catch {
    return safeError(text).slice(0, 500);
  }
}
