import type { ExtractedContent } from "./interfaces";

/** Deterministic adapter for already-retrieved GitHub repository/release API JSON. */
export class GitHubJsonContentExtractor {
  extract(body: string, fallbackTitle: string): ExtractedContent {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Unsupported GitHub JSON payload");
    const record = value as Record<string, unknown>;
    const title =
      string(record.name) ??
      string(record.tag_name) ??
      string(record.full_name) ??
      fallbackTitle;
    const description = string(record.description) ?? string(record.body) ?? "";
    const publishedAt = validDate(
      string(record.published_at) ?? string(record.created_at),
    );
    const text = [title, description].filter(Boolean).join("\n\n");
    return {
      title,
      author:
        typeof record.author === "object" && record.author
          ? string((record.author as Record<string, unknown>).login)
          : undefined,
      publishedAt,
      canonicalUrl: string(record.html_url),
      text,
      headings: [title],
      excerpts: description ? [description.slice(0, 400)] : [],
      metadata: {
        githubId: record.id,
        prerelease: record.prerelease,
        draft: record.draft,
      },
      warnings: [],
    };
  }
}
function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function validDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
