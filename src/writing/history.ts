import type { ResearchPacket } from "../research/models";
import type { ArticleHistoryRepository } from "./interfaces";

export interface OverlapReport {
  exactTitle: boolean;
  slugCollision: boolean;
  sameTopic: boolean;
  sameEvent: boolean;
  substantialMatches: { id: string; title: string; score: number }[];
  warnings: string[];
}
export async function detectOverlap(
  history: ArticleHistoryRepository,
  packet: ResearchPacket,
  title: string,
  slug: string,
): Promise<OverlapReport> {
  const entries = await history.list();
  const normalizedTitle = normalize(title);
  const keywords = tokens(
    `${packet.approvedTitle} ${packet.approvedAngle} ${packet.recommendedThesis}`,
  );
  const substantialMatches = entries
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      score: jaccard(
        keywords,
        tokens(`${entry.title} ${entry.summary} ${entry.keywords.join(" ")}`),
      ),
    }))
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  const exactTitle = entries.some(
    (x) => normalize(x.title) === normalizedTitle,
  );
  const slugCollision = entries.some(
    (x) => x.slug === slug && x.topicId !== packet.topicId,
  );
  const sameTopic = entries.some((x) => x.topicId === packet.topicId);
  const hashes = new Set(packet.contentHashes);
  const sameEvent = entries.some((x) =>
    x.researchContentHashes.some((hash) => hashes.has(hash)),
  );
  return {
    exactTitle,
    slugCollision,
    sameTopic,
    sameEvent,
    substantialMatches,
    warnings: [
      ...(exactTitle ? ["Exact title already exists"] : []),
      ...(slugCollision ? ["Slug already belongs to another topic"] : []),
      ...(sameTopic
        ? ["This topic already has article history; treat this as an update"]
        : []),
      ...(sameEvent
        ? ["Research content overlaps an existing article event"]
        : []),
      ...substantialMatches.map(
        (x) =>
          `Substantial deterministic overlap (${Math.round(x.score * 100)}%) with ${x.title}`,
      ),
    ],
  };
}
function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function tokens(value: string) {
  return [
    ...new Set(
      normalize(value)
        .split(" ")
        .filter((x) => x.length > 3),
    ),
  ];
}
function jaccard(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const right = new Set(b);
  return a.filter((x) => right.has(x)).length / new Set([...a, ...b]).size;
}
