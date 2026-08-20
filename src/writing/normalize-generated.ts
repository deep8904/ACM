import {
  articleWritingResultSchema,
  type ArticleWritingResult,
} from "./models";

const citationMarker = /\[(?:source|sources):[^\]]+\]/g;

export function normalizeGeneratedArticleIdentity(
  value: unknown,
  identity: {
    topicId: string;
    researchPacketId: string;
    researchPacketVersion: number;
    articleType: ArticleWritingResult["articleType"];
  },
) {
  if (!value || typeof value !== "object") return value;
  return {
    ...(value as Record<string, unknown>),
    schemaVersion: "1.0",
    topicId: identity.topicId,
    researchPacketId: identity.researchPacketId,
    researchPacketVersion: identity.researchPacketVersion,
    articleType: identity.articleType,
  };
}

export function normalizeGeneratedArticle(
  value: ArticleWritingResult,
): ArticleWritingResult {
  const lines = unwrapOuterMdxFence(value.mdx).split("\n");
  const mdx: string[] = [];
  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (!heading) {
      mdx.push(line);
      continue;
    }
    const markers = heading[2]!.match(citationMarker) ?? [];
    const text = stripCitationMarkers(heading[2]!);
    mdx.push(`${heading[1]} ${text}`);
    if (markers.length) mdx.push("", markers.join(" "));
  }
  return articleWritingResultSchema.parse({
    ...value,
    mdx: mdx.join("\n"),
    headingOutline: value.headingOutline.map((heading) => ({
      ...heading,
      text: stripCitationMarkers(heading.text),
    })),
    claimReferences: value.claimReferences.map((reference) => ({
      ...reference,
      section: stripCitationMarkers(reference.section),
    })),
  });
}

function stripCitationMarkers(value: string) {
  return value.replace(citationMarker, "").replace(/\s+/g, " ").trim();
}

function unwrapOuterMdxFence(value: string) {
  const match =
    /^\s*```(?:mdx|markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(value);
  return match?.[1] ?? value;
}
