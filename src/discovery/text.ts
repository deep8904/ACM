const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function stripMarkup(value: string): string {
  return decodeEntities(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#x")) {
        return safeCodePoint(Number.parseInt(entity.slice(2), 16), match);
      }
      if (entity.startsWith("#")) {
        return safeCodePoint(Number.parseInt(entity.slice(1), 10), match);
      }
      return namedEntities[entity.toLowerCase()] ?? match;
    },
  );
}

function safeCodePoint(codePoint: number, fallback: string): string {
  try {
    return Number.isFinite(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  } catch {
    return fallback;
  }
}
