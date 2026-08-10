import type { SourceItem } from "./models/source-item";
import { normalizeText } from "./models/source-item";

export type DuplicateReason =
  "canonical-url" | "source-identifier" | "content-hash" | "normalized-title";

export interface DuplicateRecord {
  itemId: string;
  duplicateOf: string;
  reason: DuplicateReason;
}

export interface DeduplicationReport {
  inputCount: number;
  outputCount: number;
  duplicateCount: number;
  reasonCounts: Record<DuplicateReason, number>;
  duplicates: DuplicateRecord[];
}

export function deduplicateItems(items: readonly SourceItem[]): {
  items: SourceItem[];
  report: DeduplicationReport;
} {
  const unique: SourceItem[] = [];
  const duplicates: DuplicateRecord[] = [];
  const canonicalUrls = new Map<string, string>();
  const sourceIdentifiers = new Map<string, string>();
  const contentHashes = new Map<string, string>();
  const normalizedTitles = new Map<string, string>();

  for (const item of items) {
    const sourceIdentifier = item.sourceItemId
      ? `${item.sourceId}\0${item.sourceItemId}`
      : undefined;
    const normalizedTitle = normalizeText(item.title).toLocaleLowerCase("en");
    const match =
      findMatch(canonicalUrls, item.canonicalUrl, "canonical-url") ??
      findMatch(sourceIdentifiers, sourceIdentifier, "source-identifier") ??
      findMatch(contentHashes, item.contentHash, "content-hash") ??
      findMatch(normalizedTitles, normalizedTitle, "normalized-title");

    if (match) {
      duplicates.push({
        itemId: item.id,
        duplicateOf: match.id,
        reason: match.reason,
      });
      continue;
    }

    unique.push(item);
    canonicalUrls.set(item.canonicalUrl, item.id);
    if (sourceIdentifier) sourceIdentifiers.set(sourceIdentifier, item.id);
    contentHashes.set(item.contentHash, item.id);
    normalizedTitles.set(normalizedTitle, item.id);
  }

  const reasonCounts: Record<DuplicateReason, number> = {
    "canonical-url": 0,
    "source-identifier": 0,
    "content-hash": 0,
    "normalized-title": 0,
  };
  for (const duplicate of duplicates) reasonCounts[duplicate.reason] += 1;

  return {
    items: unique,
    report: {
      inputCount: items.length,
      outputCount: unique.length,
      duplicateCount: duplicates.length,
      reasonCounts,
      duplicates,
    },
  };
}

function findMatch(
  index: ReadonlyMap<string, string>,
  key: string | undefined,
  reason: DuplicateReason,
): { id: string; reason: DuplicateReason } | undefined {
  if (!key) return undefined;
  const id = index.get(key);
  return id ? { id, reason } : undefined;
}
