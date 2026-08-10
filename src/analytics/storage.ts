import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAtomicJson } from "../discovery/persistence";
import type {
  AnalyticsImportRepository,
  AnalyticsSourceRepository,
  AnalyticsSyncJobRepository,
  AnalyticsTaskRepository,
  ArticleMetricsRepository,
  EditorialInsightRepository,
  EditorialReportRepository,
  PerformanceSnapshotRepository,
  SocialMetricsRepository,
} from "./interfaces";
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
  type AnalyticsImport,
  type AnalyticsSource,
  type AnalyticsSyncJob,
  type ArticleMetrics,
  type AssistedAnalysis,
  type EditorialInsight,
  type EditorialReport,
  type InsightAction,
  type PerformanceSnapshot,
  type SocialMetrics,
} from "./models";

const safe = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Unsafe analytics identifier");
  return value;
};
const missing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";
async function optional<T>(path: string, schema: z.ZodType<T>) {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function names(path: string) {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
async function exclusive(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    )
      return false;
    throw error;
  }
}
async function secure(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
async function readCollection<T>(path: string, schema: z.ZodType<T>) {
  const output: T[] = [];
  for (const name of await names(path)) {
    if (!name.endsWith(".json")) continue;
    const value = await optional(join(path, name), schema);
    if (value) output.push(value);
  }
  return output;
}

export class FileAnalyticsSourceRepository implements AnalyticsSourceRepository {
  constructor(private root: string) {}
  save(value: AnalyticsSource) {
    return writeAtomicJson(
      join(this.root, "sources", `${safe(value.id)}.json`),
      analyticsSourceSchema.parse(value),
    );
  }
  list() {
    return readCollection(join(this.root, "sources"), analyticsSourceSchema);
  }
}
export class FileAnalyticsSyncJobRepository implements AnalyticsSyncJobRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "sync", `${safe(id)}.json`);
  }
  save(value: AnalyticsSyncJob) {
    return writeAtomicJson(
      this.path(value.id),
      analyticsSyncJobSchema.parse(value),
    );
  }
  get(id: string) {
    return optional(this.path(id), analyticsSyncJobSchema);
  }
  list() {
    return readCollection(join(this.root, "sync"), analyticsSyncJobSchema);
  }
}
export class FileArticleMetricsRepository implements ArticleMetricsRepository {
  constructor(private root: string) {}
  async saveMany(values: ArticleMetrics[]) {
    for (const value of values) {
      const parsed = articleMetricsSchema.parse(value);
      await exclusive(
        join(
          this.root,
          "article-metrics",
          safe(parsed.publicationId),
          `${safe(parsed.id)}.json`,
        ),
        parsed,
      );
    }
  }
  async list(publicationId?: string) {
    const out: ArticleMetrics[] = [];
    const ids = publicationId
      ? [safe(publicationId)]
      : await names(join(this.root, "article-metrics"));
    for (const id of ids)
      out.push(
        ...(await readCollection(
          join(this.root, "article-metrics", id),
          articleMetricsSchema,
        )),
      );
    return out.sort(
      (a, b) =>
        a.windowStart.localeCompare(b.windowStart) || a.id.localeCompare(b.id),
    );
  }
}
export class FileSocialMetricsRepository implements SocialMetricsRepository {
  constructor(private root: string) {}
  async saveMany(values: SocialMetrics[]) {
    for (const value of values) {
      const parsed = socialMetricsSchema.parse(value);
      await exclusive(
        join(
          this.root,
          "social-metrics",
          safe(parsed.publicationId),
          `${safe(parsed.id)}.json`,
        ),
        parsed,
      );
    }
  }
  async list(publicationId?: string) {
    const out: SocialMetrics[] = [];
    const ids = publicationId
      ? [safe(publicationId)]
      : await names(join(this.root, "social-metrics"));
    for (const id of ids)
      out.push(
        ...(await readCollection(
          join(this.root, "social-metrics", id),
          socialMetricsSchema,
        )),
      );
    return out.sort(
      (a, b) =>
        a.windowStart.localeCompare(b.windowStart) || a.id.localeCompare(b.id),
    );
  }
}
export class FilePerformanceSnapshotRepository implements PerformanceSnapshotRepository {
  constructor(private root: string) {}
  private path(publicationId: string, period: string) {
    return join(
      this.root,
      "snapshots",
      safe(publicationId),
      `${safe(period)}.json`,
    );
  }
  save(value: PerformanceSnapshot) {
    const parsed = performanceSnapshotSchema.parse(value);
    return exclusive(this.path(parsed.publicationId, parsed.period), parsed);
  }
  get(publicationId: string, period: string) {
    return optional(
      this.path(publicationId, period),
      performanceSnapshotSchema,
    );
  }
  async list() {
    const out: PerformanceSnapshot[] = [];
    for (const id of await names(join(this.root, "snapshots")))
      out.push(
        ...(await readCollection(
          join(this.root, "snapshots", id),
          performanceSnapshotSchema,
        )),
      );
    return out.sort(
      (a, b) =>
        a.publicationId.localeCompare(b.publicationId) ||
        a.period.localeCompare(b.period),
    );
  }
}
export class FileEditorialInsightRepository implements EditorialInsightRepository {
  constructor(private root: string) {}
  async saveMany(values: EditorialInsight[]) {
    for (const value of values)
      await writeAtomicJson(
        join(this.root, "insights", `${safe(value.id)}.json`),
        editorialInsightSchema.parse(value),
      );
  }
  list() {
    return readCollection(join(this.root, "insights"), editorialInsightSchema);
  }
  action(value: InsightAction) {
    const parsed = insightActionSchema.parse(value);
    return exclusive(
      join(
        this.root,
        "insight-actions",
        safe(parsed.insightId),
        `v${parsed.version}.json`,
      ),
      parsed,
    ).then((created) => {
      if (!created) throw new Error("Insight action version conflict");
    });
  }
  actions(insightId: string) {
    return readCollection(
      join(this.root, "insight-actions", safe(insightId)),
      insightActionSchema,
    );
  }
}
export class FileEditorialReportRepository implements EditorialReportRepository {
  constructor(private root: string) {}
  private dir(id: string) {
    return join(this.root, "reports", safe(id));
  }
  async save(value: EditorialReport, files: Record<string, string>) {
    const parsed = editorialReportSchema.parse(value),
      dir = this.dir(parsed.id),
      stage = `${dir}.stage-${randomUUID()}`;
    try {
      await mkdir(stage, { recursive: true });
      await writeAtomicJson(join(stage, "report.json"), parsed);
      for (const [name, body] of Object.entries(files))
        await secure(join(stage, name), body);
      try {
        await rename(stage, dir);
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          return false;
        throw error;
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  get(id: string) {
    return optional(join(this.dir(id), "report.json"), editorialReportSchema);
  }
  async list() {
    const out: EditorialReport[] = [];
    for (const id of await names(join(this.root, "reports"))) {
      const value = await this.get(id);
      if (value) out.push(value);
    }
    return out.sort(
      (a, b) =>
        a.periodStart.localeCompare(b.periodStart) || a.id.localeCompare(b.id),
    );
  }
}
export class FileAnalyticsImportRepository implements AnalyticsImportRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "imports", `${safe(id)}.json`);
  }
  async findByHash(hash: string) {
    return (await this.list()).find((value) => value.fileHash === hash);
  }
  save(value: AnalyticsImport) {
    const parsed = analyticsImportSchema.parse(value);
    return exclusive(this.path(parsed.id), parsed).then((created) => {
      if (!created) throw new Error("Analytics import already exists");
    });
  }
  list() {
    return readCollection(join(this.root, "imports"), analyticsImportSchema);
  }
  async removeOlderThan(cutoff: string, dryRun: boolean) {
    const selected = (await this.list())
      .filter((value) => value.importedAt < cutoff)
      .map((value) => this.path(value.id));
    if (!dryRun) for (const path of selected) await unlink(path);
    return selected.map((path) => path.split("/").at(-1) ?? "unknown");
  }
}
export class FileAnalyticsTaskRepository implements AnalyticsTaskRepository {
  constructor(private root: string) {}
  private dir(id: string) {
    return join(this.root, safe(id));
  }
  async write(id: string, files: Record<string, string>) {
    for (const [name, body] of Object.entries(files))
      await secure(join(this.dir(id), name), body);
    return this.dir(id);
  }
  saveAnalysis(id: string, value: AssistedAnalysis) {
    return writeAtomicJson(
      join(this.dir(id), "analysis.json"),
      assistedAnalysisSchema.parse(value),
    );
  }
  getAnalysis(id: string) {
    return optional(
      join(this.dir(id), "analysis.json"),
      assistedAnalysisSchema,
    );
  }
}
