import { isIP } from "node:net";

import type { FetchImplementation } from "./adapters/types";

const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchPolicy {
  fetch: FetchImplementation;
  timeoutMs: number;
  maxBytes: number;
  acceptedContentTypes: readonly string[];
  retries?: number;
  maxRedirects?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function fetchTextWithPolicy(
  inputUrl: string,
  policy: FetchPolicy,
): Promise<{ text: string; contentType: string; finalUrl: string }> {
  const retries = policy.retries ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchTextOnce(inputUrl, policy);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isTransientError(error)) break;
      await (policy.sleep ?? defaultSleep)(100 * 2 ** attempt);
    }
  }

  throw lastError;
}

async function fetchTextOnce(
  inputUrl: string,
  policy: FetchPolicy,
): Promise<{ text: string; contentType: string; finalUrl: string }> {
  let currentUrl = navigationUrl(inputUrl);
  const maxRedirects = policy.maxRedirects ?? 3;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

    try {
      const response = await policy.fetch(currentUrl, {
        headers: {
          accept: policy.acceptedContentTypes.join(", "),
          "user-agent": "AIContentMachine/0.1 (+local deterministic discovery)",
        },
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location)
          throw new Error(
            `Redirect from ${currentUrl} did not include a location`,
          );
        if (redirects === maxRedirects)
          throw new Error(`Too many redirects fetching ${inputUrl}`);
        currentUrl = navigationUrl(new URL(location, currentUrl).toString());
        continue;
      }

      if (!response.ok) {
        const error = new Error(
          `HTTP ${response.status} fetching ${currentUrl}`,
        );
        Object.assign(error, { status: response.status });
        throw error;
      }

      const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        contentType &&
        !policy.acceptedContentTypes.some((accepted) =>
          contentType.includes(accepted),
        )
      ) {
        throw new Error(
          `Unexpected content type ${contentType} from ${currentUrl}`,
        );
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > policy.maxBytes) {
        throw new Error(
          `Response from ${currentUrl} exceeds ${policy.maxBytes} bytes`,
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > policy.maxBytes) {
        throw new Error(
          `Response from ${currentUrl} exceeds ${policy.maxBytes} bytes`,
        );
      }

      return {
        text: new TextDecoder().decode(bytes),
        contentType,
        finalUrl: currentUrl,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Request timed out after ${policy.timeoutMs}ms: ${currentUrl}`,
          {
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Could not fetch ${inputUrl}`);
}

function navigationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid HTTP(S) URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`Invalid HTTP(S) URL: ${value}`);
  if (url.username || url.password)
    throw new Error("HTTP navigation URLs must not contain credentials");

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata" ||
    hostname === "metadata.google.internal" ||
    isBlockedAddress(hostname)
  ) {
    throw new Error(
      `HTTP navigation blocked private or local host: ${hostname}`,
    );
  }

  url.hash = "";
  return url.toString();
}

function isBlockedAddress(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    const [a = -1, b = -1, c = -1] = hostname.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(hostname) === 6) {
    if (hostname === "::" || hostname === "::1") return true;
    if (
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname) ||
      hostname.startsWith("ff") ||
      hostname.startsWith("2001:db8")
    )
      return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(hostname)?.[1];
    return mapped ? isBlockedAddress(mapped) : false;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: number }).status;
  return status === undefined || transientStatuses.has(status);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
