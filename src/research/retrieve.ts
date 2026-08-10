import type { DnsLookup } from "../telegram/interfaces";
import { systemDnsLookup, validateNavigationUrl } from "../telegram/safe-url";
import type { ResearchConfig } from "./config";

export type ResearchFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
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
) {
  let current = await validateNavigationUrl(input, lookup);
  const visited: string[] = [];
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    current = await validateNavigationUrl(current, lookup);
    visited.push(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetcher(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: accepted.join(", "),
          "user-agent": config.userAgent,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === config.maxRedirects)
          throw new Error("Unsafe or excessive redirect chain");
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!accepted.some((x) => type.includes(x)))
        throw new Error(`Unsupported content type: ${type}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > config.maxBytes)
        throw new Error("Response is oversized");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > config.maxBytes)
        throw new Error("Response is oversized");
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
