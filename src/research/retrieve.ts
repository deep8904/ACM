import type { DnsLookup } from "../telegram/interfaces";
import { systemDnsLookup, validateNavigationUrl } from "../telegram/safe-url";
import type { ResearchConfig } from "./config";

export type ResearchFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
export type RetrievalDiagnosticCode =
  | "429_retry_after"
  | "429_cooldown"
  | "robots_denied"
  | "403_forbidden"
  | "alternate_official_found"
  | "no_retrievable_primary";

export class ResearchRetrievalError extends Error {
  constructor(
    message: string,
    readonly code?: RetrievalDiagnosticCode,
    readonly retryAt?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ResearchRetrievalError";
  }
}

export interface RetrievalPolicyHooks {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  beforeAttempt?: (input: {
    host: string;
    canonicalUrl: string;
    attemptedAt: string;
  }) => Promise<{ allowed: boolean; retryAt?: string }>;
  recordOutcome?: (input: {
    host: string;
    canonicalUrl: string;
    code: RetrievalDiagnosticCode;
    retryAt?: string;
    status: number;
    recordedAt: string;
  }) => Promise<void>;
  clearOutcome?: (host: string, canonicalUrl: string) => Promise<void>;
}
const accepted = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
  "application/pdf",
];
export async function retrieveSafely(
  input: string,
  config: ResearchConfig,
  fetcher: ResearchFetch = fetch,
  lookup: DnsLookup = systemDnsLookup,
  hooks: RetrievalPolicyHooks = {},
) {
  let current = await validateNavigationUrl(input, lookup);
  const visited: string[] = [];
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    current = await validateNavigationUrl(current, lookup);
    visited.push(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      let response: Response | undefined;
      const canonicalUrl = new URL(current).toString();
      const host = new URL(current).hostname.toLowerCase();
      for (
        let attempt = 1;
        attempt <= config.maxRetrievalAttempts;
        attempt += 1
      ) {
        const now = (hooks.now ?? (() => new Date()))();
        const claim = await hooks.beforeAttempt?.({
          host,
          canonicalUrl,
          attemptedAt: now.toISOString(),
        });
        if (claim && !claim.allowed)
          throw new ResearchRetrievalError(
            "HTTP 429 host cooldown is active",
            "429_cooldown",
            claim.retryAt,
            429,
          );
        response = await fetcher(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: accepted.join(", "),
            "user-agent": config.userAgent,
          },
        });
        if (response.status !== 429) break;

        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
          now,
          config.retryAfterMaxMs,
        );
        const challenged = response.headers
          .get("x-vercel-mitigated")
          ?.toLowerCase()
          .includes("challenge");
        const delayMs = challenged
          ? config.hostCooldownMinutes * 60_000
          : (retryAfterMs ??
            boundedBackoff(
              attempt,
              config.retryBaseDelayMs,
              config.retryMaxDelayMs,
              hooks.random ?? Math.random,
            ));
        const retryAt = new Date(now.getTime() + delayMs).toISOString();
        await hooks.recordOutcome?.({
          host,
          canonicalUrl,
          code: retryAfterMs !== undefined ? "429_retry_after" : "429_cooldown",
          retryAt,
          status: 429,
          recordedAt: now.toISOString(),
        });
        if (
          challenged ||
          delayMs > config.retryInlineMaxDelayMs ||
          attempt === config.maxRetrievalAttempts
        )
          throw new ResearchRetrievalError(
            challenged
              ? "HTTP 429 anti-bot challenge; automated retry is not permitted"
              : delayMs > config.retryInlineMaxDelayMs
                ? "HTTP 429 retry is deferred until the server cooldown"
                : "HTTP 429 retry budget exhausted",
            retryAfterMs !== undefined ? "429_retry_after" : "429_cooldown",
            retryAt,
            429,
          );
        await (hooks.sleep ?? defaultSleep)(delayMs);
      }
      if (!response) throw new Error("Retrieval failed");
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === config.maxRedirects)
          throw new Error("Unsafe or excessive redirect chain");
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        const code = response.status === 403 ? "403_forbidden" : undefined;
        if (code)
          await hooks.recordOutcome?.({
            host,
            canonicalUrl,
            code,
            status: response.status,
            recordedAt: (hooks.now ?? (() => new Date()))().toISOString(),
          });
        throw new ResearchRetrievalError(
          `HTTP ${response.status}`,
          code,
          undefined,
          response.status,
        );
      }
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!accepted.some((x) => type.includes(x)))
        throw new Error(`Unsupported content type: ${type}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > config.maxBytes)
        throw new Error("Response is oversized");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > config.maxBytes)
        throw new Error("Response is oversized");
      await hooks.clearOutcome?.(host, canonicalUrl);
      return {
        body: new TextDecoder().decode(bytes),
        contentType: type,
        finalUrl: current,
        redirects: visited,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Retrieval failed");
}

export function parseRetryAfter(
  value: string | null,
  now: Date,
  maximumMs: number,
) {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  const delay = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Math.max(0, Date.parse(value) - now.getTime());
  return Number.isFinite(delay) ? Math.min(delay, maximumMs) : undefined;
}

function boundedBackoff(
  attempt: number,
  baseMs: number,
  maximumMs: number,
  random: () => number,
) {
  const ceiling = Math.min(maximumMs, baseMs * 2 ** (attempt - 1));
  return Math.max(1, Math.round(ceiling * (0.5 + random() * 0.5)));
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function robotsAllows(
  text: string,
  path: string,
  agent = "AIContentMachine",
) {
  let active = false;
  let sawAgent = false;
  const rules: { allow: boolean; path: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (field?.toLowerCase() === "user-agent") {
      sawAgent = true;
      active = value === "*" || value.toLowerCase() === agent.toLowerCase();
    } else if (
      active &&
      ["allow", "disallow"].includes(field?.toLowerCase() ?? "")
    )
      rules.push({ allow: field?.toLowerCase() === "allow", path: value });
  }
  if (text.trim() && !sawAgent) return false;
  const match = rules
    .filter((r) => r.path && path.startsWith(r.path))
    .sort(
      (a, b) =>
        b.path.length - a.path.length || Number(b.allow) - Number(a.allow),
    )[0];
  return match?.allow ?? true;
}
