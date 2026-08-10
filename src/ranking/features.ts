import type { EntityRule, RankingConfig } from "./config";
import { normalizeStoryTitle, titleTokens } from "./title";

export interface ExtractedFeatures {
  normalizedTitle: string;
  titleTokens: string[];
  summaryTokens: string[];
  keywords: string[];
  entities: string[];
  productIdentifiers: string[];
  eventKeywords: string[];
  rumorMatches: string[];
}

export function extractFeatures(
  title: string,
  summary: string,
  config: RankingConfig,
): ExtractedFeatures {
  const normalizedTitle = normalizeStoryTitle(title, config);
  const normalizedSummary = normalizeStoryTitle(summary, {
    nonSemanticPrefixes: [],
    publisherSuffixes: [],
  });
  const stopWords = new Set(
    config.stopWords.map((word) => word.toLocaleLowerCase("en")),
  );
  const titleTerms = titleTokens(normalizedTitle).filter(
    (term) => !stopWords.has(term),
  );
  const summaryTerms = titleTokens(normalizedSummary).filter(
    (term) => !stopWords.has(term),
  );
  const entities = extractEntityHints(
    `${title} ${summary}`,
    config.entityRules,
  );
  const productIdentifiers = extractProductIdentifiers(
    `${title} ${summary}`,
    config.entityRules,
  );
  const eventKeywords = matchConfiguredPhrases(
    `${normalizedTitle} ${normalizedSummary}`,
    config.eventKeywords,
  );
  const rumorMatches = matchConfiguredPhrases(
    `${normalizedTitle} ${normalizedSummary}`,
    config.rumorPatterns,
  );

  return {
    normalizedTitle,
    titleTokens: unique(titleTerms),
    summaryTokens: unique(summaryTerms),
    keywords: rankKeywords(
      titleTerms,
      summaryTerms,
      entities,
      config.clustering.keywordCount,
    ),
    entities,
    productIdentifiers,
    eventKeywords,
    rumorMatches,
  };
}

export function extractEntityHints(
  text: string,
  rules: readonly EntityRule[],
): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en");
  const matches = rules
    .filter((rule) =>
      rule.aliases.some((alias) =>
        phrasePresent(normalized, alias.toLocaleLowerCase("en")),
      ),
    )
    .map((rule) => rule.canonical);
  return unique(matches).sort((a, b) => a.localeCompare(b));
}

export function extractProductIdentifiers(
  text: string,
  rules: readonly EntityRule[],
): string[] {
  const configured = rules
    .filter((rule) =>
      ["product", "framework", "hardware", "engine"].includes(rule.type),
    )
    .filter((rule) =>
      rule.aliases.some((alias) =>
        phrasePresent(
          text.toLocaleLowerCase("en"),
          alias.toLocaleLowerCase("en"),
        ),
      ),
    )
    .map((rule) => rule.canonical);
  const patterns =
    text.match(
      /\b(?:gpt-\d+(?:\.\d+)?(?:\s+(?:api|mini|pro))?|rtx\s*\d{3,4}|ios\s*\d+|next\.js\s*\d+(?:\.\d+)?|v?\d+(?:\.\d+){1,3})\b/gi,
    ) ?? [];
  return unique([...configured, ...patterns.map(canonicalIdentifier)]).sort(
    (a, b) => a.localeCompare(b),
  );
}

function rankKeywords(
  titleTerms: readonly string[],
  summaryTerms: readonly string[],
  entities: readonly string[],
  limit: number,
): string[] {
  const weights = new Map<string, number>();
  for (const term of titleTerms)
    weights.set(term, (weights.get(term) ?? 0) + 3);
  for (const term of summaryTerms)
    weights.set(term, (weights.get(term) ?? 0) + 1);
  for (const entity of entities) {
    const key = entity.toLocaleLowerCase("en");
    weights.set(key, (weights.get(key) ?? 0) + 8);
  }
  return [...weights.entries()]
    .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.localeCompare(b))
    .slice(0, limit)
    .map(([term]) => term);
}

function matchConfiguredPhrases(
  text: string,
  phrases: readonly string[],
): string[] {
  return phrases
    .filter((phrase) => phrasePresent(text, phrase.toLocaleLowerCase("en")))
    .map((phrase) => phrase.toLocaleLowerCase("en"))
    .sort((a, b) => a.localeCompare(b));
}

function phrasePresent(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

function canonicalIdentifier(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^gpt/i, "GPT")
    .replace(/^rtx/i, "RTX")
    .replace(/^ios/i, "iOS")
    .replace(/^next\.js/i, "Next.js")
    .trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
