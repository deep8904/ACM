import { stripMarkup } from "../discovery/text";

export interface TitleNormalizationOptions {
  publisherSuffixes: readonly string[];
  nonSemanticPrefixes: readonly string[];
}

export function normalizeStoryTitle(
  title: string,
  options: TitleNormalizationOptions,
): string {
  let normalized = stripMarkup(title)
    .normalize("NFKC")
    .replace(/(\p{L})(\.net\b)/giu, "$1 $2")
    .replace(/[–—−]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();

  const prefixPattern = options.nonSemanticPrefixes.map(escapeRegExp).join("|");
  if (prefixPattern) {
    normalized = normalized.replace(
      new RegExp(`^(?:${prefixPattern})\\s*:\\s*`, "i"),
      "",
    );
  }

  for (const suffix of [...options.publisherSuffixes].sort(
    (a, b) => b.length - a.length,
  )) {
    const suffixPattern = new RegExp(
      `\\s+(?:-|\\|)\\s*${escapeRegExp(suffix)}$`,
      "i",
    );
    if (suffixPattern.test(normalized)) {
      normalized = normalized.replace(suffixPattern, "");
      break;
    }
  }

  return normalized
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}+.\-#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleTokens(normalizedTitle: string): string[] {
  return (
    normalizedTitle.match(
      /(?:\.net|c\+\+|[\p{L}\p{N}]+(?:[.+#-][\p{L}\p{N}]+)*)/gu,
    ) ?? []
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
