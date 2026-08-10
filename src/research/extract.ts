import { createHash } from "node:crypto";

export interface ExtractedDocument {
  title: string;
  author?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  text: string;
  headings: string[];
  excerpts: string[];
  metadata: Record<string, unknown>;
  warnings: string[];
}

export function extractDocument(
  body: string,
  contentType: string,
  fallbackTitle: string,
): ExtractedDocument {
  if (contentType.includes("pdf"))
    return {
      title: fallbackTitle,
      text: "",
      headings: [],
      excerpts: [],
      metadata: {},
      warnings: ["PDF extraction is deferred; metadata only"],
    };
  if (!contentType.includes("html") && !contentType.includes("xhtml")) {
    const text = clean(body);
    return {
      title: fallbackTitle,
      text,
      headings: [],
      excerpts: chooseExcerpts(text),
      metadata: {},
      warnings: [],
    };
  }
  const withoutNoise = body
    .replace(/<(script|style|noscript|nav|footer|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(
      /<[^>]+(?:hidden|aria-hidden=["']true["'])[^>]*>[\s\S]*?<\/[^>]+>/gi,
      " ",
    );
  const meta = (name: string) =>
    decode(
      new RegExp(
        `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)`,
        "i",
      ).exec(body)?.[1] ??
        new RegExp(
          `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`,
          "i",
        ).exec(body)?.[1] ??
        "",
    );
  const title =
    clean(
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ??
        meta("og:title") ??
        fallbackTitle,
    ) || fallbackTitle;
  const headings = [
    ...withoutNoise.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi),
  ]
    .map((m) => clean(m[1] ?? ""))
    .filter(Boolean);
  const blocks = [
    ...withoutNoise.matchAll(
      /<(?:p|li|blockquote|td|th|pre|code)[^>]*>([\s\S]*?)<\/(?:p|li|blockquote|td|th|pre|code)>/gi,
    ),
  ]
    .map((m) => clean(m[1] ?? ""))
    .filter((x) => x.length >= 20);
  const canonicalUrl =
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i.exec(body)?.[1];
  const published =
    meta("article:published_time") ||
    meta("datePublished") ||
    /"datePublished"\s*:\s*"([^"]+)"/i.exec(body)?.[1];
  return {
    title,
    author: meta("author") || undefined,
    publishedAt: validDate(published),
    canonicalUrl,
    text: clean([...headings, ...blocks].join("\n\n")),
    headings,
    excerpts: chooseExcerpts(blocks.join("\n")),
    metadata: { description: meta("description") || meta("og:description") },
    warnings: blocks.length < 2 ? ["Low extraction quality"] : [],
  };
}

export function contentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
export function chooseExcerpts(text: string, max = 4, chars = 400) {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map(clean)
    .filter((x) => x.length >= 40)
    .slice(0, max)
    .map((x) => x.slice(0, chars));
}
function clean(value: string) {
  return decode(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
function decode(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
function validDate(value?: string) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
