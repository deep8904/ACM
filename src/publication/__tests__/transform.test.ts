import { describe, expect, it } from "vitest";
import type { ArticleDraft } from "../../writing/models";
import type { ResearchSource } from "../../research/models";
import {
  articlePath,
  canonicalUrl,
  publicSourceUrl,
  renderCitations,
  transformForPublication,
  validatePublicArtifact,
} from "../transform";
import { publicationConfigSchema } from "../config";
const config = publicationConfigSchema.parse({
  mode: "fixture",
  repository: "fixture/blog",
  defaultBranch: "main",
  branchStrategy: "direct",
  contentRoot: "content/blog",
  pathPattern: "content/blog/{year}/{slug}.mdx",
  siteOrigin: "https://example.com/",
  blogRoutePrefix: "/blog",
  citationStyle: "numbered_footnotes",
  commitMessagePattern: "publish: add {title}",
  deploymentProvider: "mock",
  deploymentPolicy: "required",
  deploymentTimeoutSeconds: 60,
  pollIntervalSeconds: 2,
  publicPageVerification: false,
  maximumAttempts: 3,
  scheduledGraceMinutes: 60,
  claimTimeoutMinutes: 30,
  notifications: true,
});
const source = {
  id: "source_aaaaaaaaaaaaaaaaaaaaaaaa",
  canonicalUrl: "https://docs.example.com/release?utm_source=x&token=bad",
  title: "Release notes",
  publisher: "Example",
  publishedAt: "2026-08-06T00:00:00.000Z",
  isPrimary: true,
  sourceType: "release_notes",
} as ResearchSource;
const draft = {
  title: "A precise release analysis title",
  slug: "release-analysis",
  description:
    "A sufficiently detailed description of the release and the practical changes readers should understand.",
  category: "Software",
  tags: ["release"],
  author: "Deep",
  articleType: "news_analysis",
  heroImage: null,
  heroAlt: "Abstract release illustration",
  readingTimeMinutes: 5,
  mdx: "## What changed\n\nThe cache changed.[source:source_aaaaaaaaaaaaaaaaaaaaaaaa]",
} as ArticleDraft;
describe("publication transformation", () => {
  it("renders stable citations and public frontmatter without internal IDs", () => {
    const x = transformForPublication({
      draft,
      sources: [source],
      config,
      publishedAt: "2026-08-06T12:00:00.000Z",
    });
    expect(x.mdx).toContain('status: "published"');
    expect(x.mdx).toContain("[^1]");
    expect(x.mdx).not.toMatch(/source_[a-f0-9]/);
    expect(x.sources[0]?.url).toBe("https://docs.example.com/release");
    expect(x.canonicalUrl).toBe("https://example.com/blog/release-analysis");
    validatePublicArtifact(x.mdx);
  });
  it("deduplicates citations in first-use order", () => {
    const x = renderCitations(
      `${draft.mdx}\nAgain.[source:${source.id}]`,
      [source],
      "2026-08-06T12:00:00.000Z",
    );
    expect(x.references).toHaveLength(1);
    expect(x.body.match(/\[\^1\]/g)).toHaveLength(3);
  });
  it("rejects unknown, private, traversal and leaked values", () => {
    expect(() =>
      renderCitations(
        "Fact.[source:source_bbbbbbbbbbbbbbbbbbbbbbbb]",
        [source],
        "2026-08-06T12:00:00.000Z",
      ),
    ).toThrow(/Unknown/);
    expect(() => publicSourceUrl("http://127.0.0.1/private")).toThrow(
      /Private/,
    );
    expect(() =>
      articlePath(
        { ...config, pathPattern: "content/blog/../{slug}.mdx" },
        draft.slug,
        "2026-08-06T12:00:00.000Z",
      ),
    ).toThrow();
    expect(() => validatePublicArtifact("approvalNotes: private")).toThrow();
  });
  it("normalizes canonical paths", () => {
    expect(canonicalUrl(config, "release-analysis")).toBe(
      "https://example.com/blog/release-analysis",
    );
    expect(
      articlePath(config, "release-analysis", "2026-08-06T12:00:00.000Z"),
    ).toBe("content/blog/2026/release-analysis.mdx");
  });
});
