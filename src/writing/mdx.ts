const citationPattern = /\[(source|sources):([^\]]+)\]/g;

export interface MdxInspection {
  headings: { level: number; text: string }[];
  citationSourceIds: string[];
  unknownCitationSourceIds: string[];
  links: string[];
  safetyIssues: string[];
  plainText: string;
}

export function inspectMdx(
  mdx: string,
  knownSourceIds: Set<string>,
): MdxInspection {
  const safetyIssues: string[] = [];
  if (/^---\s*$/m.test(mdx.slice(0, 20)))
    safetyIssues.push("Writer output must not contain frontmatter");
  const withoutCode = mdx.replace(/```[\s\S]*?```/g, "");
  const forbidden: [RegExp, string][] = [
    [/^\s*(?:import|export)\s/m, "MDX imports and exports are forbidden"],
    [/<\/?[A-Za-z][^>]*>/, "Raw HTML and JSX are forbidden"],
    [/[{}]/, "Executable MDX expressions are forbidden"],
    [/\bon[A-Z][A-Za-z]*\s*=/i, "Event handlers are forbidden"],
    [/\b(?:javascript|data|vbscript):/i, "Dangerous URL schemes are forbidden"],
    [
      /(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S+/i,
      "Embedded credentials are forbidden",
    ],
    [
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i,
      "Private-network URLs are forbidden",
    ],
    [
      /[?&](?:token|key|secret|password|signature)=/i,
      "Sensitive URL query parameters are forbidden",
    ],
  ];
  for (const [pattern, message] of forbidden)
    if (pattern.test(withoutCode)) safetyIssues.push(message);
  const links = [
    ...withoutCode.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
  ].map((x) => x[1] ?? "");
  for (const link of links) {
    if (link.includes(".."))
      safetyIssues.push(`Path traversal is forbidden: ${link}`);
    if (!/^(?:https?:\/\/|\/|#|mailto:)/i.test(link))
      safetyIssues.push(`Unsupported link target: ${link}`);
  }
  const headings = [...withoutCode.matchAll(/^(#{2,6})\s+(.+)$/gm)].map(
    (x) => ({ level: x[1]?.length ?? 0, text: (x[2] ?? "").trim() }),
  );
  const citationSourceIds: string[] = [];
  const allCitationLike = [
    ...withoutCode.matchAll(/\[(?:source|sources):[^\]]*\]/g),
  ].map((x) => x[0]);
  for (const match of withoutCode.matchAll(citationPattern)) {
    const ids = (match[2] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    citationSourceIds.push(...ids);
    const lineStart = withoutCode.lastIndexOf("\n", match.index ?? 0) + 1;
    if (withoutCode.slice(lineStart, match.index).trimStart().startsWith("#"))
      safetyIssues.push("Citation markers are not allowed in headings");
  }
  const unique = [...new Set(citationSourceIds)];
  if (
    allCitationLike.length !== [...withoutCode.matchAll(citationPattern)].length
  )
    safetyIssues.push("Malformed citation marker");
  return {
    headings,
    citationSourceIds: unique,
    unknownCitationSourceIds: unique.filter((id) => !knownSourceIds.has(id)),
    links,
    safetyIssues: [...new Set(safetyIssues)],
    plainText: toPlainText(mdx),
  };
}

export function toPlainText(mdx: string): string {
  return mdx
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(citationPattern, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderFrontmatter(values: Record<string, unknown>): string {
  const lines = Object.entries(values).map(
    ([key, value]) =>
      `${key}: ${value === null ? "null" : JSON.stringify(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}
