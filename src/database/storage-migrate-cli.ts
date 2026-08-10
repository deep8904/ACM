import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  analyticsImportSchema,
  analyticsSourceSchema,
  analyticsSyncJobSchema,
  articleMetricsSchema,
  assistedAnalysisSchema,
  editorialInsightSchema,
  editorialReportSchema,
  insightActionSchema,
  performanceSnapshotSchema,
  socialMetricsSchema,
} from "../analytics/models";
import {
  consumptionRecordSchema,
  deploymentRecordSchema,
  publicationJobSchema,
  publicationRecordSchema,
  publicationVerificationSchema,
} from "../publication/models";
import {
  researchJobSchema,
  researchPacketSchema,
  researchSourceSchema,
} from "../research/models";
import {
  articleFinalApprovedEventSchema,
  draftPreviewSchema,
  editorialReviewJobSchema,
  editorialReviewResultSchema,
  finalApprovalRecordSchema,
  finalConversationStateSchema,
} from "../review/models";
import {
  postedRecordSchema,
  socialApprovalSchema,
  socialConversationSchema,
  socialExportSchema,
  socialHistorySchema,
  socialPackageSchema,
  socialJobSchema,
  socialRevisionSchema,
} from "../social/models";
import {
  createPostgresRepositories,
  storagePaths,
} from "../storage/composition";
import {
  conversationStateSchema,
  messageIndexSchema,
  processedUpdateSchema,
  topicApprovalSchema,
  topicApprovedEventSchema,
  topicQueueItemSchema,
} from "../telegram/models";
import {
  articleDraftSchema,
  articleHistoryEntrySchema,
  draftQualityReportSchema,
  writingJobSchema,
} from "../writing/models";
import { closeDatabaseClient, createDatabaseClient } from "./client";
import { readStorageConfiguration } from "./config";
import { checkDatabaseHealth } from "./health";
import { redactDatabaseSecrets } from "./errors";

interface Entry {
  stage: string;
  path: string;
  relativePath: string;
  byteCount: number;
  sha256: string;
}
interface Result extends Entry {
  status: "planned" | "imported" | "reused" | "preserved_artifact" | "error";
  message?: string;
}

const stageOrder = [
  "telegram",
  "research",
  "writing",
  "review",
  "publication",
  "social",
  "analytics",
] as const;

async function main() {
  const from = option("--from"),
    to = option("--to"),
    dryRun = process.argv.includes("--dry-run"),
    confirmed = process.argv.includes("--confirm");
  if (from !== "file" || to !== "postgres" || dryRun === confirmed)
    throw new Error(
      "Usage: storage:migrate -- --from file --to postgres (--dry-run | --confirm)",
    );
  const paths = storagePaths();
  const roots: Record<(typeof stageOrder)[number], string[]> = {
    telegram: [paths.telegram, paths.topicEvents],
    research: [paths.research, paths.researchTasks],
    writing: [paths.writing, paths.writingTasks],
    review: [
      paths.review,
      paths.reviewTasks,
      paths.revisionTasks,
      paths.finalApproval,
      paths.finalEvents,
    ],
    publication: [paths.publication],
    social: [paths.social, paths.socialTasks, paths.socialRevisionTasks],
    analytics: [paths.analytics, paths.analyticsTasks],
  };
  const entries: Entry[] = [];
  for (const stage of stageOrder)
    for (const root of roots[stage])
      entries.push(...(await inventory(stage, root)));
  entries.sort(
    (a, b) =>
      stageOrder.indexOf(a.stage as never) -
        stageOrder.indexOf(b.stage as never) ||
      dependencyRank(a) - dependencyRank(b) ||
      a.relativePath.localeCompare(b.relativePath),
  );
  const runId = `storagemigration_${randomUUID().replaceAll("-", "")}`;
  const results: Result[] = entries.map((entry) => ({
    ...entry,
    status: "planned",
  }));
  if (confirmed) {
    const storage = readStorageConfiguration({
      ...process.env,
      STORAGE_BACKEND: "postgres",
    });
    if (!storage.database) throw new Error("DATABASE_URL is required");
    const sql = createDatabaseClient(storage.database);
    try {
      const health = await checkDatabaseHealth(sql);
      if (!health.healthy)
        throw new Error(
          "Run npm run db:migrate and npm run db:verify before storage migration",
        );
      const repositories = createPostgresRepositories(sql);
      for (let index = 0; index < results.length; index++) {
        const result = results[index]!;
        try {
          const status = await importEntry(result, repositories);
          results[index] = { ...result, status };
        } catch (error) {
          results[index] = {
            ...result,
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    } finally {
      await closeDatabaseClient(sql);
    }
  }
  const manifest = {
    id: runId,
    sourceBackend: "file",
    targetBackend: "postgres",
    dryRun,
    createdAt: new Date().toISOString(),
    sourceDeleted: false,
    order: stageOrder,
    totals: count(results),
    entries: results,
    retry:
      "Re-run --dry-run, resolve error entries, then re-run --confirm. Source files are never deleted.",
  };
  const directory = path.resolve("data/migration-manifests");
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, `${runId}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      { manifestPath, ...manifest.totals, dryRun, sourceDeleted: false },
      null,
      2,
    ),
  );
  if (results.some((result) => result.status === "error")) process.exitCode = 1;
}

type Repositories = ReturnType<typeof createPostgresRepositories>;
async function importEntry(
  entry: Entry,
  repositories: Repositories,
): Promise<Result["status"]> {
  const extension = path.extname(entry.path).toLowerCase();
  if (extension !== ".json") {
    await preserve(entry, await readFile(entry.path, "utf8"), repositories);
    return "preserved_artifact";
  }
  const raw = await readFile(entry.path, "utf8");
  const document = JSON.parse(raw) as unknown;
  if (isDerivedIndex(entry.relativePath)) {
    await preserve(entry, document, repositories);
    return "preserved_artifact";
  }
  const queue = topicQueueItemSchema.safeParse(document);
  if (queue.success) {
    await repositories.telegram.saveQueueItem(queue.data);
    return "imported";
  }
  const conversation = conversationStateSchema.safeParse(document);
  if (conversation.success) {
    await repositories.telegram.saveConversation(conversation.data);
    return "imported";
  }
  const message = messageIndexSchema.safeParse(document);
  if (message.success) {
    await repositories.telegram.saveMessageIndex(message.data);
    return "imported";
  }
  const processed = processedUpdateSchema.safeParse(document);
  if (processed.success) {
    if (await repositories.telegram.hasProcessedUpdate(processed.data.updateId))
      return "reused";
    await repositories.telegram.claimUpdate(
      processed.data.updateId,
      processed.data.callbackQueryId,
      processed.data.processedAt,
    );
    if (processed.data.status === "completed")
      await repositories.telegram.completeUpdate(processed.data);
    return "imported";
  }
  const approval = topicApprovalSchema.safeParse(document);
  if (approval.success) {
    if (await repositories.telegram.getById(approval.data.id)) return "reused";
    await repositories.telegram.saveApproval(approval.data);
    return "imported";
  }
  const topicEvent = topicApprovedEventSchema.safeParse(document);
  if (topicEvent.success)
    return (await repositories.telegram.saveApprovedEvent(topicEvent.data))
      ? "imported"
      : "reused";
  const researchJob = researchJobSchema.safeParse(document);
  if (researchJob.success) {
    await repositories.research.jobs.save(researchJob.data);
    return "imported";
  }
  const packet = researchPacketSchema.safeParse(document);
  if (packet.success) {
    if (
      await repositories.research.packets.get(
        packet.data.topicId,
        packet.data.version,
      )
    )
      return "reused";
    await repositories.research.packets.save(packet.data);
    return "imported";
  }
  const source = researchSourceSchema.safeParse(document);
  if (source.success) {
    const text = await readFile(
      path.join(path.dirname(entry.path), "extracted.txt"),
      "utf8",
    );
    await repositories.research.sources.save(source.data, text);
    return "imported";
  }
  const draft = articleDraftSchema.safeParse(document);
  if (draft.success) {
    if (
      await repositories.writing.drafts.findByImportHash(
        draft.data.provenance.importHash,
      )
    )
      return "reused";
    const dir = path.dirname(entry.path);
    const quality = draftQualityReportSchema.parse(
      JSON.parse(await readFile(path.join(dir, "quality-report.json"), "utf8")),
    );
    const provenance = JSON.parse(
      await readFile(path.join(dir, "import-provenance.json"), "utf8"),
    ) as unknown;
    await repositories.writing.drafts.saveBundle(
      draft.data,
      await readFile(path.join(dir, "article.mdx"), "utf8"),
      await readFile(path.join(dir, "plain-text.txt"), "utf8"),
      quality,
      provenance,
    );
    return "imported";
  }
  const writingJob = writingJobSchema.safeParse(document);
  if (writingJob.success) {
    await repositories.writing.jobs.save(writingJob.data);
    return "imported";
  }
  const review = editorialReviewResultSchema.safeParse(document);
  if (review.success) {
    if (
      await repositories.review.reviews.findByImportHash(
        review.data.provenance.importHash,
      )
    )
      return "reused";
    const dir = path.dirname(entry.path);
    const deterministic = JSON.parse(
      await readFile(path.join(dir, "deterministic-report.json"), "utf8"),
    ) as never;
    const provenance = JSON.parse(
      await readFile(path.join(dir, "import-provenance.json"), "utf8"),
    ) as unknown;
    await repositories.review.reviews.save(
      review.data,
      deterministic,
      provenance,
    );
    return "imported";
  }
  const reviewJob = editorialReviewJobSchema.safeParse(document);
  if (reviewJob.success) {
    await repositories.review.jobs.save(reviewJob.data);
    return "imported";
  }
  const finalConversation = finalConversationStateSchema.safeParse(document);
  if (finalConversation.success) {
    await repositories.review.conversations.save(finalConversation.data);
    return "imported";
  }
  const preview = draftPreviewSchema.safeParse(document);
  if (preview.success) {
    const html = await readFile(preview.data.path, "utf8").catch(() => "");
    await repositories.review.previews.save(preview.data, html);
    return "imported";
  }
  const finalApproval = finalApprovalRecordSchema.safeParse(document);
  if (finalApproval.success) {
    await repositories.review.approvals.save(finalApproval.data);
    return "imported";
  }
  const finalEvent = articleFinalApprovedEventSchema.safeParse(document);
  if (finalEvent.success)
    return (await repositories.review.events.save(finalEvent.data))
      ? "imported"
      : "reused";
  const publicationJob = publicationJobSchema.safeParse(document);
  if (publicationJob.success) {
    await repositories.publication.jobs.save(publicationJob.data);
    return "imported";
  }
  const publication = publicationRecordSchema.safeParse(document);
  if (publication.success) {
    await repositories.publication.publications.save(publication.data);
    return "imported";
  }
  const consumption = consumptionRecordSchema.safeParse(document);
  if (consumption.success)
    return (await repositories.publication.consumption.consume(
      consumption.data,
    ))
      ? "imported"
      : "reused";
  const deployment = deploymentRecordSchema.safeParse(document);
  if (deployment.success) {
    await repositories.publication.deployments.save(deployment.data);
    return "imported";
  }
  const verification = publicationVerificationSchema.safeParse(document);
  if (verification.success) {
    await repositories.publication.verifications.save(verification.data);
    return "imported";
  }
  const socialJob = socialJobSchema.safeParse(document);
  if (socialJob.success) {
    await repositories.social.jobs.save(socialJob.data);
    return "imported";
  }
  const socialPackage = socialPackageSchema.safeParse(document);
  if (socialPackage.success) {
    if (
      await repositories.social.packages.findByImportHash(
        socialPackage.data.provenance.importHash,
      )
    )
      return "reused";
    const dir = path.dirname(entry.path);
    const qualityDir = path.join(dir, "quality");
    const quality = [];
    for (const name of await safeNames(qualityDir)) {
      quality.push(
        JSON.parse(await readFile(path.join(qualityDir, name), "utf8")),
      );
    }
    const provenance = JSON.parse(
      await readFile(path.join(dir, "import-provenance.json"), "utf8"),
    ) as unknown;
    await repositories.social.packages.save(
      socialPackage.data,
      quality,
      provenance,
    );
    return "imported";
  }
  const socialApproval = socialApprovalSchema.safeParse(document);
  if (socialApproval.success) {
    await repositories.social.approvals.save(socialApproval.data);
    return "imported";
  }
  const socialConversation = socialConversationSchema.safeParse(document);
  if (socialConversation.success) {
    await repositories.social.conversations.save(socialConversation.data);
    return "imported";
  }
  const socialRevision = socialRevisionSchema.safeParse(document);
  if (socialRevision.success) {
    await repositories.social.revisions.write(
      socialRevision.data.publicationId,
      socialRevision.data.sourcePackageVersion,
      {},
      socialRevision.data,
    );
    return "imported";
  }
  const socialExports = socialExportSchema.array().safeParse(document);
  if (socialExports.success && socialExports.data[0]) {
    const first = socialExports.data[0];
    await repositories.social.exports.write(
      path.basename(path.dirname(entry.path)),
      first.packageVersion,
      {},
      socialExports.data,
    );
    return "imported";
  }
  const posted = postedRecordSchema.safeParse(document);
  if (posted.success) {
    await repositories.social.posted.save(posted.data);
    return "imported";
  }
  const analyticsSource = analyticsSourceSchema.safeParse(document);
  if (analyticsSource.success) {
    await repositories.analytics.sources.save(analyticsSource.data);
    return "imported";
  }
  const sync = analyticsSyncJobSchema.safeParse(document);
  if (sync.success) {
    await repositories.analytics.syncJobs.save(sync.data);
    return "imported";
  }
  const articleMetric = articleMetricsSchema.safeParse(document);
  if (articleMetric.success) {
    await repositories.analytics.articleMetrics.saveMany([articleMetric.data]);
    return "imported";
  }
  const socialMetric = socialMetricsSchema.safeParse(document);
  if (socialMetric.success) {
    await repositories.analytics.socialMetrics.saveMany([socialMetric.data]);
    return "imported";
  }
  const snapshot = performanceSnapshotSchema.safeParse(document);
  if (snapshot.success)
    return (await repositories.analytics.snapshots.save(snapshot.data))
      ? "imported"
      : "reused";
  const insight = editorialInsightSchema.safeParse(document);
  if (insight.success) {
    await repositories.analytics.insights.saveMany([insight.data]);
    return "imported";
  }
  const report = editorialReportSchema.safeParse(document);
  if (report.success) {
    const files: Record<string, string> = {};
    for (const name of await safeNames(path.dirname(entry.path)))
      if (name !== path.basename(entry.path) && !name.endsWith(".json"))
        files[name] = await readFile(
          path.join(path.dirname(entry.path), name),
          "utf8",
        );
    return (await repositories.analytics.reports.save(report.data, files))
      ? "imported"
      : "reused";
  }
  const analyticsImport = analyticsImportSchema.safeParse(document);
  if (analyticsImport.success) {
    if (
      await repositories.analytics.imports.findByHash(
        analyticsImport.data.fileHash,
      )
    )
      return "reused";
    await repositories.analytics.imports.save(analyticsImport.data);
    return "imported";
  }
  const insightAction = insightActionSchema.safeParse(document);
  if (insightAction.success) {
    await repositories.analytics.insights.action(insightAction.data);
    return "imported";
  }
  const analysis = assistedAnalysisSchema.safeParse(document);
  if (analysis.success) {
    await repositories.analytics.tasks.write(analysis.data.reportId, {});
    await repositories.analytics.tasks.saveAnalysis(
      analysis.data.reportId,
      analysis.data,
    );
    return "imported";
  }
  const articleHistory = articleHistoryEntrySchema.array().safeParse(document);
  if (articleHistory.success) {
    for (const value of articleHistory.data)
      await repositories.writing.history.add(value);
    return "imported";
  }
  const socialHistory = socialHistorySchema.array().safeParse(document);
  if (socialHistory.success) {
    for (const value of socialHistory.data)
      await repositories.social.history.add(value);
    return "imported";
  }
  await preserve(entry, document, repositories);
  return "preserved_artifact";
}

async function preserve(
  entry: Entry,
  content: unknown,
  repositories: Repositories,
) {
  const stage = stageOrder.includes(entry.stage as (typeof stageOrder)[number])
    ? entry.stage
    : "analytics";
  await repositories.artifacts.save({
    runId: "legacy_file_migration",
    stage: stage as
      | "telegram"
      | "research"
      | "writing"
      | "review"
      | "publication"
      | "social"
      | "analytics",
    name: `legacy/${shaPath(entry.path)}/${path.basename(entry.path)}`,
    mediaType:
      path.extname(entry.path) === ".json" ? "application/json" : "text/plain",
    content,
  });
}
function shaPath(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
function dependencyRank(entry: Entry) {
  const value = entry.path.toLowerCase();
  const rules = [
    /queue/,
    /approval/,
    /topic-approved/,
    /source/,
    /packet/,
    /job/,
    /draft\.json/,
    /review\.json/,
    /final-approval/,
    /article-final-approved/,
    /publication/,
    /socialpackage|package\.json/,
    /socialapproval|approvals/,
    /analyticsimport|imports/,
    /metric/,
    /snapshot/,
    /report/,
  ];
  const index = rules.findIndex((rule) => rule.test(value));
  return index < 0 ? rules.length : index;
}

async function inventory(stage: string, root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const file of await walk(root)) {
    const data = await readFile(file);
    entries.push({
      stage,
      path: file,
      relativePath: path.relative(root, file),
      byteCount: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  return entries;
}
async function walk(root: string): Promise<string[]> {
  try {
    const output: string[] = [];
    for (const name of await readdir(root)) {
      const value = path.join(root, name),
        info = await stat(value);
      if (info.isDirectory()) output.push(...(await walk(value)));
      else if (info.isFile()) output.push(value);
    }
    return output;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function safeNames(root: string) {
  try {
    return (await readdir(root)).sort();
  } catch {
    return [];
  }
}
function isDerivedIndex(value: string) {
  return /(^|\/)(index|.*-report|issues)\.json$/.test(value);
}
function count(results: Result[]) {
  const output: Record<string, number> = { total: 0 };
  for (const stage of stageOrder) output[`stage.${stage}`] = 0;
  for (const item of results) {
    output[item.status] = (output[item.status] ?? 0) + 1;
    output[`stage.${item.stage}`] = (output[`stage.${item.stage}`] ?? 0) + 1;
    output.total = (output.total ?? 0) + 1;
  }
  return output;
}
function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(
    redactDatabaseSecrets(
      error instanceof Error ? error.message : String(error),
    ),
  );
  process.exitCode = 1;
});
