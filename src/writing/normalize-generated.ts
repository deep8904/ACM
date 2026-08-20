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
  const normalized = normalizeGeneratedMdx(
    value.mdx,
    value.claimReferences,
    value.headingOutline,
  );
  return articleWritingResultSchema.parse({
    ...value,
    mdx: normalized.mdx,
    headingOutline:
      normalized.headingOutline.length >= 2
        ? normalized.headingOutline
        : normalized.declaredOutline,
    claimReferences: normalized.claimReferences,
  });
}

export function normalizeGeneratedMdx<
  T extends { section: string; statement: string },
>(
  value: string,
  claimReferences: T[],
  headingOutline: { level: number; text: string }[] = [],
) {
  const lines = unwrapOuterMdxFence(value).split("\n");
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
  const actualSections = extractSections(normalizedMdx);
  const declaredOutline = headingOutline.map((heading) => ({
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
  return {
    mdx: normalizedMdx,
    headingOutline: actualOutline,
    declaredOutline,
    claimReferences: claimReferences.map((reference) => {
      const section = normalizeHeadingText(reference.section);
      return {
        ...reference,
        section: canonicalSection(
          section,
          reference.statement,
          actualByKey,
          declaredToActual,
          actualSections,
        ),
      };
    }),
  };
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
  statement: string,
  actualByKey: Map<string, string>,
  declaredToActual: Map<string, string>,
  actualSections: { heading: string; body: string }[],
) {
  const key = headingKey(section);
  const direct = actualByKey.get(key) ?? declaredToActual.get(key);
  if (direct) return direct;
  const nameMatches = actualSections.filter(({ heading }) => {
    const candidate = headingKey(heading);
    return (
      key.length >= 4 &&
      candidate.length >= 4 &&
      (candidate.includes(key) || key.includes(candidate))
    );
  });
  if (nameMatches.length === 1) return nameMatches[0]!.heading;
  const statementKey = headingKey(statement);
  const statementMatches = actualSections.filter(({ body }) =>
    headingKey(body).includes(statementKey),
  );
  return statementMatches.length === 1 ? statementMatches[0]!.heading : section;
}

function extractSections(mdx: string) {
  const matches = [...mdx.matchAll(/^(#{2,4})\s+(.+)$/gm)];
  return matches.map((match, index) => ({
    heading: match[2]!.trim(),
    body: mdx.slice(
      (match.index ?? 0) + match[0].length,
      matches[index + 1]?.index ?? mdx.length,
    ),
  }));
}

function unwrapOuterMdxFence(value: string) {
  const match =
    /^\s*```(?:mdx|markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(value);
  return match?.[1] ?? value;
}
