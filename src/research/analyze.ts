import { createHash } from "node:crypto";
import type { ResearchConfig } from "./config";
import {
  evidenceClaimSchema,
  sufficiencySchema,
  timelineEventSchema,
  type EvidenceClaim,
  type ResearchSource,
} from "./models";
import { stable } from "./storage";

export function analyze(
  topicId: string,
  sources: ResearchSource[],
  now: string,
  config: ResearchConfig,
) {
  const claims: EvidenceClaim[] = [];
  const timeline = [];
  for (const source of sources) {
    if (["low", "metadata_only", "failed"].includes(source.extractionQuality))
      continue;
    for (const excerpt of source.selectedExcerpts) {
      if (
        !/\b(?:is|are|has|will|released|launched|supports|costs?|includes?)\b/i.test(
          excerpt.text,
        )
      )
        continue;
      claims.push(
        evidenceClaimSchema.parse({
          id: stable("claim", `${topicId}:${excerpt.text.toLowerCase()}`),
          topicId,
          statement: excerpt.text,
          normalizedStatement: excerpt.text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim(),
          claimType:
            source.authority === "community"
              ? "community_observation"
              : /\b(?:gb|tb|mhz|ghz|\$|percent|%)\b/i.test(excerpt.text)
                ? "specification"
                : "fact",
          sourceIds: [source.id],
          supportingExcerptIds: [excerpt.id],
          confidence: source.isPrimary
            ? 0.9
            : source.authority === "independent"
              ? 0.75
              : 0.55,
          status: "supported",
          disagreementSourceIds: [],
          notes: [],
          createdAt: now,
        }),
      );
    }
    if (source.publishedAt)
      timeline.push(
        timelineEventSchema.parse({
          id: stable("timeline", `${source.id}:${source.publishedAt}`),
          occurredAt: source.publishedAt,
          precision: "day",
          event: source.title,
          sourceIds: [source.id],
          confidence: source.isPrimary ? 0.9 : 0.7,
        }),
      );
  }
  const conflicts = detectConflicts(topicId, claims);
  for (const conflict of conflicts)
    for (const statement of conflict.statements)
      for (const claim of claims.filter((x) =>
        statement.sourceIds.includes(x.sourceIds[0] ?? ""),
      )) {
        claim.status = "conflicting";
        claim.disagreementSourceIds = conflict.statements
          .flatMap((x) => x.sourceIds)
          .filter((x) => !claim.sourceIds.includes(x));
        claim.confidence = Math.max(0, claim.confidence - 0.25);
      }
  const primary = sources.filter((x) => x.isPrimary).length;
  const groups = new Set(sources.map(publisherOwnershipGroup)).size;
  const extracted = sources.filter(
    (x) => x.extractionStatus === "extracted",
  ).length;
  const components = {
    primarySources: primary ? 25 : 0,
    sourceDiversity: Math.min(20, groups * 7),
    extractionQuality: sources.length
      ? Math.round((20 * extracted) / sources.length)
      : 0,
    claimCoverage: Math.min(20, claims.length * 4),
    recency: sources.some((x) => x.publishedAt) ? 10 : 0,
    scope: sources.length >= 2 ? 5 : 0,
  };
  const penalties = {
    conflicts: Math.min(30, conflicts.length * 12),
    unknowns: claims.length ? 0 : 15,
    weakSources:
      sources.length &&
      sources.every((x) => ["community", "aggregator"].includes(x.authority))
        ? 15
        : 0,
  };
  const score = Math.max(
    0,
    Math.min(
      100,
      Object.values(components).reduce((a, b) => a + b, 0) -
        Object.values(penalties).reduce((a, b) => a + b, 0),
    ),
  );
  return {
    claims,
    timeline,
    conflicts,
    sufficiency: sufficiencySchema.parse({
      score,
      threshold: config.sufficiencyThreshold,
      components,
      penalties,
      explanation: [
        `${primary} primary source(s)`,
        `${groups} publisher group(s)`,
        `${claims.length} evidence claim(s)`,
        `${conflicts.length} conflict(s)`,
      ],
    }),
    blockingReasons: [
      ...(!primary ? ["No primary source was retrieved"] : []),
      ...(claims.length === 0
        ? ["No supported factual claims were extracted"]
        : []),
      ...conflicts
        .filter((conflict) => conflict.severity === "blocking")
        .map((conflict) => `Unresolved blocking conflict: ${conflict.subject}`),
    ],
  };
}

export function publisherOwnershipGroup(source: ResearchSource) {
  if (source.publisherOwner) return source.publisherOwner.toLowerCase();
  const group = source.publisherGroup.toLowerCase();
  // GitHub operates both the github.blog publication and github.com docs.
  // This registry is deliberately narrow: it prevents those properties from
  // being counted as independent publisher ownership without changing an old
  // packet or guessing at arbitrary corporate relationships.
  if (group === "github.blog" || group.endsWith(".github.com"))
    return "github.com";
  return group;
}

function detectConflicts(topicId: string, claims: EvidenceClaim[]) {
  const found = [];
  const numeric = claims
    .map((claim) => ({
      claim,
      tokens:
        claim.statement.match(
          /(?:\$\s*)?\d+(?:\.\d+)?(?:\s*(?:gb|tb|%|percent))?/gi,
        ) ?? [],
    }))
    .filter((x) => x.tokens.length);
  for (let i = 0; i < numeric.length; i++)
    for (let j = i + 1; j < numeric.length; j++) {
      const a = numeric[i];
      const b = numeric[j];
      if (!a || !b || a.claim.sourceIds[0] === b.claim.sourceIds[0]) continue;
      const shared = a.claim.normalizedStatement
        .split(" ")
        .filter((x) => x.length > 5 && b.claim.normalizedStatement.includes(x));
      if (shared.length && a.tokens.join() !== b.tokens.join())
        found.push({
          id: `conflict_${createHash("sha256").update(`${topicId}:${a.claim.id}:${b.claim.id}`).digest("hex").slice(0, 20)}`,
          subject: shared[0] ?? "numeric detail",
          statements: [
            { statement: a.claim.statement, sourceIds: a.claim.sourceIds },
            { statement: b.claim.statement, sourceIds: b.claim.sourceIds },
          ],
          severity:
            a.claim.claimType === "specification" ||
            b.claim.claimType === "specification"
              ? ("blocking" as const)
              : ("warning" as const),
        });
    }
  return found;
}
