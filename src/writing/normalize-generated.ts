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
    const text = normalizeHeadingText(heading[2]!);
    mdx.push(`${heading[1]} ${text}`);
    if (markers.length) mdx.push("", markers.join(" "));
  }
  const normalizedMdx = mdx.join("\n");
  const actualOutline = [...normalizedMdx.matchAll(/^(#{2,4})\s+(.+)$/gm)].map(
    (heading) => ({
      level: heading[1]!.length,
      text: heading[2]!.trim(),
    }),
  );
  const declaredOutline = value.headingOutline.map((heading) => ({
    ...heading,
    text: normalizeHeadingText(heading.text),
  }));
  const declaredToActual = new Map<string, string>();
  if (
    actualOutline.length === declaredOutline.length &&
    actualOutline.every(
      (heading, index) => heading.level === declaredOutline[index]?.level,
    )
  )
    for (const [index, heading] of declaredOutline.entries())
      declaredToActual.set(
        headingKey(heading.text),
        actualOutline[index]!.text,
      );
  const actualByKey = new Map(
    actualOutline.map((heading) => [headingKey(heading.text), heading.text]),
  );
  return articleWritingResultSchema.parse({
    ...value,
    mdx: normalizedMdx,
    headingOutline: actualOutline.length >= 2 ? actualOutline : declaredOutline,
    claimReferences: value.claimReferences.map((reference) => ({
      ...reference,
      section: canonicalSection(
        normalizeHeadingText(reference.section),
        actualByKey,
        declaredToActual,
      ),
    })),
  });
}

function stripCitationMarkers(value: string) {
  return value.replace(citationMarker, "").replace(/\s+/g, " ").trim();
}

function normalizeHeadingText(value: string) {
  return stripCitationMarkers(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/\s*[:—-]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function headingKey(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function canonicalSection(
  section: string,
  actualByKey: Map<string, string>,
  declaredToActual: Map<string, string>,
) {
  const key = headingKey(section);
  return actualByKey.get(key) ?? declaredToActual.get(key) ?? section;
}

function unwrapOuterMdxFence(value: string) {
  const match =
    /^\s*```(?:mdx|markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(value);
  return match?.[1] ?? value;
}
