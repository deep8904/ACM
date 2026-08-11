import { normalizeUrl } from "../discovery/normalize-url";

export function extractOfficialAlternateUrls(input: {
  body: string;
  contentType: string;
  documentUrl: string;
  publisherOwner: string;
  targetUrl: string;
}) {
  const values = new Set<string>();
  if (/html|xhtml/i.test(input.contentType)) {
    for (const match of input.body.matchAll(
      /<link\b[^>]*\brel=["'][^"']*(?:canonical|alternate|amphtml)[^"']*["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    ))
      if (match[1]) values.add(match[1]);
    for (const match of input.body.matchAll(
      /"(?:url|mainEntityOfPage)"\s*:\s*"(https?:\\?\/\\?\/[^"\\]+(?:\\.[^"\\]*)*)"/gi,
    ))
      if (match[1]) values.add(match[1].replaceAll("\\/", "/"));
  }
  if (/xml|rss|atom/i.test(input.contentType)) {
    for (const match of input.body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi))
      if (match[1]) values.add(match[1]);
    for (const match of input.body.matchAll(
      /<(?:link|guid)>\s*(https?:\/\/[^<\s]+)\s*<\/(?:link|guid)>/gi,
    ))
      if (match[1]) values.add(match[1]);
    for (const match of input.body.matchAll(
      /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    ))
      if (match[1]) values.add(match[1]);
  }
  const target = new URL(input.targetUrl);
  const targetTerms = terms(target.pathname);
  return [...values]
    .flatMap((value) => {
      try {
        return [normalizeUrl(new URL(value, input.documentUrl).toString())];
      } catch {
        return [];
      }
    })
    .filter((value) => {
      const url = new URL(value);
      return (
        belongsToOwner(url.hostname, input.publisherOwner) &&
        value !== normalizeUrl(input.targetUrl) &&
        overlap(targetTerms, terms(url.pathname)) > 0
      );
    })
    .sort(
      (left, right) =>
        overlap(targetTerms, terms(new URL(right).pathname)) -
          overlap(targetTerms, terms(new URL(left).pathname)) ||
        left.localeCompare(right),
    );
}

export function belongsToOwner(hostname: string, owner: string) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const expected = owner.toLowerCase().replace(/^www\./, "");
  return host === expected || host.endsWith(`.${expected}`);
}

function terms(path: string) {
  return new Set(
    path
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (part) =>
          part.length > 2 && !["blogs", "journal", "pages"].includes(part),
      ),
  );
}

function overlap(left: Set<string>, right: Set<string>) {
  return [...left].filter((value) => right.has(value)).length;
}
