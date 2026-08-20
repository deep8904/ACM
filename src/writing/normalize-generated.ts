import {
  articleWritingResultSchema,
  type ArticleWritingResult,
} from "./models";

const citationMarker = /\[(?:source|sources):[^\]]+\]/g;

export function normalizeGeneratedArticle(
  value: ArticleWritingResult,
): ArticleWritingResult {
  const lines = value.mdx.split("\n");
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
