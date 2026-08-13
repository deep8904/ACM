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
  const result = assistedResearchResultSchema.parse(JSON.parse(raw));
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
  const imported = [...result.interpretations, ...result.predictions];
  const ids = new Set<string>(
    [
      ...base.facts,
      ...base.interpretations,
      ...base.predictions,
      ...base.communityObservations,
    ].map((claim) => claim.id),
  );
  for (const claim of imported) {
    if (ids.has(claim.id))
      throw new Error(`Duplicate imported claim: ${claim.id}`);
    ids.add(claim.id);
    if (
      claim.topicId !== base.topicId ||
      claim.sourceIds.some((id) => !sourceIds.has(id)) ||
      claim.supportingExcerptIds.some((id) => !excerptIds.has(id))
    )
      throw new Error(`Imported claim ${claim.id} references unknown evidence`);
    if (Date.parse(claim.createdAt) > Date.parse(now) + 60_000)
      throw new Error(`Imported claim ${claim.id} has a future timestamp`);
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
      `${imported.length} manually assisted claim(s) validated`,
    ],
  };
  const sufficient =
    score >= researchSufficiency.threshold &&
    blockingReasons.length === 0 &&
    imported.length > 0;
  const next = researchPacketSchema.parse({
    ...base,
    version,
    updatedAt: now,
    status: sufficient ? "ready" : "insufficient",
    researchMode: "assisted_import",
    executiveSummary: result.executiveSummary,
    interpretations: mergeClaims(base.interpretations, result.interpretations),
    predictions: mergeClaims(base.predictions, result.predictions),
    counterpoints: result.counterpoints,
    unknowns: [...new Set([...base.unknowns, ...result.unknowns])],
    conflicts: base.conflicts,
    recommendedThesis: result.recommendedThesis,
    recommendedArticleType: result.recommendedArticleType,
    recommendedStructure: result.recommendedStructure,
    sufficient,
    blockingReasons,
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
