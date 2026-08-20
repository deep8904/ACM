import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicJson } from "../discovery/persistence";
import type {
  AssistedResearchImportRepository,
  ApprovedEventRepository,
  ResearchPacketRepository,
  ResearchTaskRepository,
} from "./interfaces";
import {
  assistedResearchResultSchema,
  researchPacketSchema,
  type ResearchPacket,
} from "./models";
import { resolvePrimaryBlockingReasons } from "./primary-evidence";

export async function writeAssistanceTask(
  packet: ResearchPacket,
  root: string,
  promptPath: string,
  repository?: ResearchTaskRepository,
) {
  const dir = join(root, packet.topicId);
  const prompt = await readFile(promptPath, "utf8");
  const compact = {
    taskType: packet.sourceIndex.length
      ? "research_synthesis"
      : "source_discovery",
    topicId: packet.topicId,
    approvedEventId: packet.approvedEventId,
    sourcePacketVersion: packet.version,
    approvedTopic: packet.approvedTitle,
    approvedAngle: packet.approvedAngle,
    editorialNotes: packet.editorialNotes,
    sourceHierarchy: packet.sourceIndex.map((s) => ({
      id: s.id,
      title: s.title,
      publisher: s.publisher,
      authority: s.authority,
      isPrimary: s.isPrimary,
      acquisitionMode: s.acquisitionMode ?? "automatic_retrieval",
      evidenceRecordId: s.evidenceRecordId,
      originalRetrievalFailure: s.originalRetrievalFailure,
    })),
    sources: packet.sourceIndex.map((s) => ({
      id: s.id,
      summary: s.summary,
      publishedAt: s.publishedAt,
      excerpts: s.selectedExcerpts,
      acquisitionMode: s.acquisitionMode ?? "automatic_retrieval",
      canonicalUrl: s.canonicalUrl,
    })),
    deterministicFacts: packet.facts,
    conflicts: packet.conflicts,
    unknowns: packet.unknowns,
  };
  const expectedSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "AssistedResearchResult",
    type: "object",
    required: [
      "schemaVersion",
      "topicId",
      "approvedEventId",
      "sourcePacketVersion",
      "executiveSummary",
      "interpretations",
      "predictions",
      "counterpoints",
      "unknowns",
      "recommendedThesis",
      "recommendedArticleType",
      "recommendedStructure",
    ],
    additionalProperties: false,
    properties: {
      schemaVersion: { const: "1.0" },
      topicId: { type: "string" },
      approvedEventId: { type: "string" },
      sourcePacketVersion: { type: "integer", minimum: 1 },
      executiveSummary: { type: "string", maxLength: 4000 },
      interpretations: {
        type: "array",
        items: { $ref: "#/definitions/claim" },
      },
      predictions: { type: "array", items: { $ref: "#/definitions/claim" } },
      counterpoints: {
        type: "array",
        items: { type: "string", maxLength: 1000 },
      },
      unknowns: { type: "array", items: { type: "string", maxLength: 1000 } },
      recommendedThesis: { type: "string", maxLength: 2000 },
      recommendedArticleType: {
        enum: [
          "news_analysis",
          "explainer",
          "comparison",
          "technical_deep_dive",
          "opinion",
          "unknown",
        ],
      },
      recommendedStructure: {
        type: "array",
        items: { type: "string", maxLength: 500 },
      },
    },
    definitions: {
      claim: {
        type: "object",
        required: [
          "id",
          "topicId",
          "statement",
          "normalizedStatement",
          "claimType",
          "sourceIds",
          "supportingExcerptIds",
          "confidence",
          "status",
          "disagreementSourceIds",
          "notes",
          "createdAt",
        ],
        additionalProperties: false,
      },
    },
  };
  const sourceDiscovery = packet.sourceIndex.length
    ? ""
    : "\n\n## Source discovery required\n\nNo credible source is attached. Locate primary and independent sources manually, submit their URLs through the Telegram topic approval workflow, and rerun research. Do not invent source IDs or synthesize claims yet.";
  const markdown = `# Manual research assistance\n\nNo model is invoked by this project. Copy the prompt and compact input into Claude Code or Gemini manually, then save only the JSON result.\n\n## Prompt\n\n${prompt}\n\n## Input\n\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\`${sourceDiscovery}\n`;
  if (repository)
    return repository.write(
      packet.topicId,
      packet.version,
      {
        "research-input.json": JSON.stringify(compact, null, 2),
        "expected-output.schema.json": JSON.stringify(expectedSchema, null, 2),
        "research-assistance.md": markdown,
      },
      compact,
    );
  await mkdir(dir, { recursive: true });
  await writeAtomicJson(join(dir, "research-input.json"), compact);
  await writeAtomicJson(
    join(dir, "expected-output.schema.json"),
    expectedSchema,
  );
  const { open } = await import("node:fs/promises");
  const handle = await open(join(dir, "research-assistance.md"), "w", 0o600);
  try {
    await handle.writeFile(markdown);
  } finally {
    await handle.close();
  }
  return dir;
}

export async function importAssistance(
  path: string,
  packets: ResearchPacketRepository,
  events: ApprovedEventRepository,
  now = new Date().toISOString(),
  imports?: AssistedResearchImportRepository,
) {
  const raw = await readFile(path, "utf8");
  const importHash = createHash("sha256").update(raw).digest("hex");
  const normalized = normalizeAssistedClaimTimestamps(JSON.parse(raw), now);
  const result = assistedResearchResultSchema.parse(normalized.value);
  const existing = await packets.getByImportHash(result.topicId, importHash);
  if (existing && !imports) return existing;
  const base = await packets.get(result.topicId, result.sourcePacketVersion);
  if (!base || base.approvedEventId !== result.approvedEventId)
    throw new Error(
      "Assisted result does not match its immutable source packet",
    );
  const sourceIds = new Set(base.sourceIndex.map((s) => s.id));
  const excerptIds = new Set(
    base.sourceIndex.flatMap((s) => s.selectedExcerpts.map((e) => e.id)),
  );
  const baseClaims = [
    ...base.facts,
    ...base.interpretations,
    ...base.predictions,
    ...base.communityObservations,
  ];
  const collisionNormalized = normalizeImportedClaimIds(
    result.interpretations,
    result.predictions,
    baseClaims,
  );
  const imported = [
    ...collisionNormalized.interpretations,
    ...collisionNormalized.predictions,
  ];
  const ids = new Set<string>(baseClaims.map((claim) => claim.id));
  for (const claim of imported) {
    ids.add(claim.id);
    if (
      claim.topicId !== base.topicId ||
      claim.sourceIds.some((id) => !sourceIds.has(id)) ||
      claim.supportingExcerptIds.some((id) => !excerptIds.has(id))
    )
      throw new Error(`Imported claim ${claim.id} references unknown evidence`);
  }
  const version = await packets.nextVersion(base.topicId);
  const blockingReasons = resolvePrimaryBlockingReasons(
    base,
    base.blockingReasons,
  ).filter((x) => !x.startsWith("No supported factual claims"));
  const components = {
    ...base.researchSufficiency.components,
    claimCoverage: Math.min(
      20,
      base.researchSufficiency.components.claimCoverage + imported.length * 4,
    ),
  };
  const score = Math.max(
    0,
    Math.min(
      100,
      Object.values(components).reduce((sum, value) => sum + value, 0) -
        Object.values(base.researchSufficiency.penalties).reduce(
          (sum, value) => sum + value,
          0,
        ),
    ),
  );
  const researchSufficiency = {
    ...base.researchSufficiency,
    score,
    components,
    explanation: [
      ...base.researchSufficiency.explanation,
      `${imported.length} new manually assisted claim(s) validated`,
    ],
  };
  const sufficient =
    score >= researchSufficiency.threshold &&
    blockingReasons.length === 0 &&
    base.interpretations.length + base.predictions.length + imported.length > 0;
  const next = researchPacketSchema.parse({
    ...base,
    version,
    updatedAt: now,
    status: sufficient ? "ready" : "insufficient",
    researchMode: "assisted_import",
    executiveSummary: result.executiveSummary,
    interpretations: mergeClaims(
      base.interpretations,
      collisionNormalized.interpretations,
    ),
    predictions: mergeClaims(base.predictions, collisionNormalized.predictions),
    counterpoints: result.counterpoints,
    unknowns: [...new Set([...base.unknowns, ...result.unknowns])],
    conflicts: base.conflicts,
    recommendedThesis: result.recommendedThesis,
    recommendedArticleType: result.recommendedArticleType,
    recommendedStructure: result.recommendedStructure,
    sufficient,
    blockingReasons,
    warnings: [
      ...new Set([
        ...base.warnings,
        ...normalized.diagnostics,
        ...collisionNormalized.diagnostics,
      ]),
    ],
    researchSufficiency,
    provenance: {
      deterministic: false,
      importedAt: now,
      importedBy: "manual",
      promptVersion: base.provenance.promptVersion,
      sourcePacketVersion: base.version,
      importHash,
      humanAssistedEvidence: base.provenance.humanAssistedEvidence,
    },
  });
  if (imports) return imports.persist(next, now);
  await packets.save(next);
  await events.consume(next.approvedEventId, next.id, next.version, now);
  return next;
}

export function normalizeImportedClaimIds<
  T extends {
    id: string;
    statement: string;
    normalizedStatement: string;
    claimType: string;
    sourceIds: string[];
    supportingExcerptIds: string[];
    notes: string[];
  },
>(interpretations: T[], predictions: T[], baseClaims: T[]) {
  const diagnostics: string[] = [];
  const existing = new Map(baseClaims.map((claim) => [claim.id, claim]));
  const normalize = (claims: T[]) =>
    claims.flatMap((claim) => {
      const collision = existing.get(claim.id);
      if (!collision) {
        existing.set(claim.id, claim);
        return [claim];
      }
      if (sameClaim(collision, claim)) {
        diagnostics.push(
          `Imported claim ${claim.id} duplicated existing evidence and was reused`,
        );
        return [];
      }
      let salt = 0;
      let id: string;
      do {
        id = `claim_${createHash("sha256")
          .update(
            `${claim.id}:${claim.normalizedStatement}:${claim.claimType}:${salt}`,
          )
          .digest("hex")
          .slice(0, 24)}`;
        salt += 1;
      } while (existing.has(id));
      const diagnostic = `Imported claim ID ${claim.id} collided with different existing evidence; normalized to ${id}`;
      const normalized = {
        ...claim,
        id,
        notes: [...claim.notes, diagnostic],
      };
      existing.set(id, normalized);
      diagnostics.push(diagnostic);
      return [normalized];
    });
  return {
    interpretations: normalize(interpretations),
    predictions: normalize(predictions),
    diagnostics,
  };
}

function sameClaim(
  left: {
    normalizedStatement: string;
    claimType: string;
    sourceIds: string[];
    supportingExcerptIds: string[];
  },
  right: {
    normalizedStatement: string;
    claimType: string;
    sourceIds: string[];
    supportingExcerptIds: string[];
  },
) {
  return (
    left.normalizedStatement === right.normalizedStatement &&
    left.claimType === right.claimType &&
    [...left.sourceIds].sort().join() === [...right.sourceIds].sort().join() &&
    [...left.supportingExcerptIds].sort().join() ===
      [...right.supportingExcerptIds].sort().join()
  );
}

export function normalizeAssistedClaimTimestamps(value: unknown, now: string) {
  const importTime = Date.parse(now);
  if (!Number.isFinite(importTime))
    throw new Error(`Invalid assisted research import time: ${now}`);
  const diagnostics: string[] = [];
  if (!value || typeof value !== "object") return { value, diagnostics };
  const root = value as Record<string, unknown>;
  const normalizeClaims = (input: unknown) =>
    Array.isArray(input)
      ? input.map((item) => {
          if (!item || typeof item !== "object") return item;
          const claim = item as Record<string, unknown>;
          const claimId =
            typeof claim.id === "string" ? claim.id : "unknown claim";
          const supplied = claim.createdAt;
          const hasTimezone =
            typeof supplied === "string" &&
            /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(supplied);
          const parsed =
            hasTimezone && typeof supplied === "string"
              ? Date.parse(supplied)
              : Number.NaN;
          let createdAt: string;
          let diagnostic: string | undefined;
          if (!Number.isFinite(parsed)) {
            createdAt = new Date(importTime).toISOString();
            diagnostic = `Imported claim ${claimId} timestamp was missing, invalid, or lacked a timezone; normalized to import time ${createdAt}`;
          } else if (parsed > importTime) {
            createdAt = new Date(importTime).toISOString();
            diagnostic = `Imported claim ${claimId} future timestamp ${String(supplied)} was rejected; normalized to import time ${createdAt}`;
          } else {
            createdAt = new Date(parsed).toISOString();
          }
          if (diagnostic) diagnostics.push(diagnostic);
          return {
            ...claim,
            createdAt,
            notes: diagnostic
              ? [...(Array.isArray(claim.notes) ? claim.notes : []), diagnostic]
              : claim.notes,
          };
        })
      : input;
  return {
    value: {
      ...root,
      interpretations: normalizeClaims(root.interpretations),
      predictions: normalizeClaims(root.predictions),
    },
    diagnostics,
  };
}

export async function repairPrimaryBlockingState(
  base: ResearchPacket,
  packets: ResearchPacketRepository,
  now = new Date().toISOString(),
) {
  const latest = await packets.get(base.topicId);
  if (
    latest &&
    latest.version > base.version &&
    latest.provenance.sourcePacketVersion === base.version &&
    resolvePrimaryBlockingReasons(latest, latest.blockingReasons).length ===
      latest.blockingReasons.length
  )
    return latest;
  const blockingReasons = resolvePrimaryBlockingReasons(
    base,
    base.blockingReasons,
  );
  if (blockingReasons.length === base.blockingReasons.length) return base;
  const assistedClaims = [...base.interpretations, ...base.predictions];
  const sufficient =
    base.researchSufficiency.score >= base.researchSufficiency.threshold &&
    blockingReasons.length === 0 &&
    assistedClaims.length > 0;
  const next = researchPacketSchema.parse({
    ...base,
    version: await packets.nextVersion(base.topicId),
    updatedAt: now,
    status: sufficient ? "ready" : "insufficient",
    sufficient,
    blockingReasons,
    provenance: {
      ...base.provenance,
      sourcePacketVersion: base.version,
      importHash: undefined,
    },
  });
  await packets.save(next);
  return next;
}

function mergeClaims<T extends { id: string }>(base: T[], imported: T[]) {
  return [
    ...new Map(
      [...base, ...imported].map((claim) => [claim.id, claim]),
    ).values(),
  ];
}
