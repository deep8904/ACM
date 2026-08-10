import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { RankingConfig } from "./config";
import {
  historyEntrySchema,
  type HistoryEntry,
  type StoryCluster,
} from "./models";

export interface HistoryRepository {
  list(): Promise<HistoryEntry[]>;
}

export class FileHistoryRepository implements HistoryRepository {
  constructor(private readonly path: string) {}

  async list(): Promise<HistoryEntry[]> {
    try {
      return z
        .array(historyEntrySchema)
        .parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return [];
      throw new Error(`Could not load topic history from ${this.path}`, {
        cause: error,
      });
    }
  }
}

export interface SuppressionDecision {
  suppress: boolean;
  penalty: number;
  reasons: string[];
  meaningfulUpdateOverride: boolean;
}

export function evaluateRecentCoverage(
  cluster: StoryCluster,
  history: readonly HistoryEntry[],
  config: RankingConfig,
  now: Date,
): SuppressionDecision {
  const relevant = history
    .filter((entry) => withinWindow(entry, config, now))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const updateTerms = config.meaningfulUpdateTerms.filter((term) =>
    containsTerm(
      `${cluster.normalizedTitle} ${cluster.keywords.join(" ")}`,
      term,
    ),
  );

  for (const entry of relevant) {
    if (entry.clusterFingerprint === cluster.fingerprint) {
      return {
        suppress: true,
        penalty: config.scoring.penalties.recentCoverage,
        reasons: [`exact recent ${entry.status} topic match: ${entry.title}`],
        meaningfulUpdateOverride: false,
      };
    }

    const entityOverlap = overlap(cluster.entities, entry.entities);
    const productOverlap = overlap(
      cluster.productIdentifiers,
      entry.productIdentifiers,
    );
    const eventOverlap = overlap(cluster.eventKeywords, entry.eventKeywords);
    const keywordOverlap = jaccard(cluster.keywords, entry.keywords);
    if (
      productOverlap > 0 &&
      updateTerms.length > 0 &&
      cluster.latestSignalAt > entry.date
    ) {
      return {
        suppress: false,
        penalty: 0,
        reasons: [
          `meaningful update override (${updateTerms.join(", ")}) for ${entry.title}`,
        ],
        meaningfulUpdateOverride: true,
      };
    }
    const substantial =
      (productOverlap > 0 && (eventOverlap > 0 || keywordOverlap >= 0.25)) ||
      (entityOverlap > 0 && eventOverlap > 0 && keywordOverlap >= 0.45);
    if (!substantial) continue;

    return {
      suppress: true,
      penalty: config.scoring.penalties.recentCoverage,
      reasons: [
        `substantial overlap with recent ${entry.status} topic: ${entry.title}`,
      ],
      meaningfulUpdateOverride: false,
    };
  }

  return {
    suppress: false,
    penalty: 0,
    reasons: [],
    meaningfulUpdateOverride: false,
  };
}

function withinWindow(
  entry: HistoryEntry,
  config: RankingConfig,
  now: Date,
): boolean {
  const windowDays = config.suppressionWindowsDays[entry.status];
  return now.getTime() - Date.parse(entry.date) <= windowDays * 86_400_000;
}

function overlap(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right.map(lower));
  return new Set(left.map(lower).filter((value) => rightSet.has(value))).size;
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left.map(lower));
  const rightSet = new Set(right.map(lower));
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  return (
    [...leftSet].filter((value) => rightSet.has(value)).length / union.size
  );
}

function containsTerm(text: string, term: string): boolean {
  return text.toLocaleLowerCase("en").includes(term.toLocaleLowerCase("en"));
}

function lower(value: string): string {
  return value.toLocaleLowerCase("en");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
