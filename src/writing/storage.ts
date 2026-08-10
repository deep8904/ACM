import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeAtomicJson } from "../discovery/persistence";
import type { ResearchPacket } from "../research/models";
import { FileTelegramRepository } from "../telegram/file-repository";
import {
  articleDraftSchema,
  articleHistoryEntrySchema,
  draftQualityReportSchema,
  writingJobSchema,
  type ArticleDraft,
  type ArticleHistoryEntry,
  type DraftQualityReport,
  type WritingJob,
} from "./models";
import type {
  ArticleDraftRepository,
  ArticleHistoryRepository,
  DraftQualityRepository,
  WritingGateRepository,
  WritingJobRepository,
  WritingTaskRepository,
} from "./interfaces";
import { sha256 } from "./task";

const safe = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`Unsafe identifier: ${value}`);
  return value;
};
const missing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";
async function optional<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function secureText(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export class FileWritingJobRepository implements WritingJobRepository {
  constructor(private root: string) {}
  private path(topicId: string, version: number) {
    return join(this.root, "jobs", `${safe(topicId)}_v${version}.json`);
  }
  async claim(
    topicId: string,
    packet: ResearchPacket,
    articleType: WritingJob["articleType"],
    configHash: string,
    workerId: string,
    now: string,
  ) {
    const existing = await this.get(topicId, packet.version);
    if (
      existing &&
      !["failed", "blocked", "cancelled"].includes(existing.status)
    )
      return existing;
    const job = writingJobSchema.parse({
      id: `writingjob_${sha256(`${topicId}:${packet.version}`).slice(0, 24)}`,
      topicId,
      researchPacketId: packet.id,
      researchPacketVersion: packet.version,
      articleType,
      configHash,
      researchContentHashes: packet.contentHashes,
      attempt: (existing?.attempt ?? 0) + 1,
      status: "claimed",
      startedAt: now,
      heartbeatAt: now,
      workerId,
      version: (existing?.version ?? 0) + 1,
    });
    await writeAtomicJson(this.path(topicId, packet.version), job);
    return job;
  }
  async get(topicId: string, researchVersion?: number) {
    if (researchVersion)
      return optional(this.path(topicId, researchVersion), writingJobSchema);
    const files = await this.files();
    const jobs = await Promise.all(
      files
        .filter((x) => x.startsWith(`${safe(topicId)}_v`))
        .map((x) => optional(join(this.root, "jobs", x), writingJobSchema)),
    );
    return jobs
      .filter(Boolean)
      .sort(
        (a, b) =>
          (b?.researchPacketVersion ?? 0) - (a?.researchPacketVersion ?? 0),
      )[0];
  }
  async getById(id: string) {
    const jobs = await Promise.all(
      (await this.files()).map((x) =>
        optional(join(this.root, "jobs", x), writingJobSchema),
      ),
    );
    return jobs.find((x) => x?.id === id);
  }
  async save(job: WritingJob) {
    await writeAtomicJson(
      this.path(job.topicId, job.researchPacketVersion),
      writingJobSchema.parse(job),
    );
  }
  private async files() {
    try {
      return (await readdir(join(this.root, "jobs"))).filter((x) =>
        x.endsWith(".json"),
      );
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
}

export class FileArticleDraftRepository implements ArticleDraftRepository {
  constructor(private root: string) {}
  private dir(topicId: string, version: number) {
    return join(this.root, "drafts", safe(topicId), `v${version}`);
  }
  async nextVersion(topicId: string) {
    try {
      return (
        Math.max(
          0,
          ...(await readdir(join(this.root, "drafts", safe(topicId)))).map(
            (x) => Number(/^v(\d+)$/.exec(x)?.[1] ?? 0),
          ),
        ) + 1
      );
    } catch (error) {
      if (missing(error)) return 1;
      throw error;
    }
  }
  async get(topicId: string, version?: number) {
    if (!version)
      version = (
        await optional(
          join(this.root, "drafts", safe(topicId), "index.json"),
          z.object({ latestVersion: z.number().int().positive() }),
        )
      )?.latestVersion;
    return version
      ? optional(
          join(this.dir(topicId, version), "draft.json"),
          articleDraftSchema,
        )
      : undefined;
  }
  async findByImportHash(hash: string) {
    try {
      for (const topic of await readdir(join(this.root, "drafts"))) {
        const draft = await this.get(topic);
        if (draft?.provenance.importHash === hash) return draft;
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return undefined;
  }
  async getQuality(topicId: string, version?: number) {
    const draft = await this.get(topicId, version);
    return draft
      ? optional(
          join(this.dir(topicId, draft.version), "quality-report.json"),
          draftQualityReportSchema,
        )
      : undefined;
  }
  async saveBundle(
    draft: ArticleDraft,
    mdx: string,
    plainText: string,
    quality: DraftQualityReport,
    imported: unknown,
  ) {
    const value = articleDraftSchema.parse(draft);
    const finalDir = this.dir(value.topicId, value.version);
    const stage = `${finalDir}.stage-${randomUUID()}`;
    try {
      await mkdir(stage, { recursive: true });
      await Promise.all([
        secureText(join(stage, "article.mdx"), mdx),
        secureText(join(stage, "plain-text.txt"), plainText),
        writeAtomicJson(join(stage, "draft.json"), value),
        writeAtomicJson(join(stage, "quality-report.json"), quality),
        writeAtomicJson(join(stage, "import-provenance.json"), imported),
      ]);
      await rename(stage, finalDir);
      await writeAtomicJson(
        join(this.root, "drafts", safe(value.topicId), "index.json"),
        {
          draftId: value.id,
          latestVersion: value.version,
          status: value.status,
          updatedAt: value.updatedAt,
        },
      );
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
}

export class FileDraftQualityRepository implements DraftQualityRepository {
  constructor(private drafts: FileArticleDraftRepository) {}
  get(topicId: string, version?: number) {
    return this.drafts.getQuality(topicId, version);
  }
}
export class FileArticleHistoryRepository implements ArticleHistoryRepository {
  constructor(private root: string) {}
  private path() {
    return join(this.root, "history", "articles.json");
  }
  async list() {
    return (
      (await optional(this.path(), z.array(articleHistoryEntrySchema))) ?? []
    );
  }
  async add(entry: ArticleHistoryEntry) {
    const items = await this.list();
    if (items.some((x) => x.id === entry.id)) return;
    await writeAtomicJson(
      this.path(),
      [...items, articleHistoryEntrySchema.parse(entry)].sort(
        (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
      ),
    );
  }
}
export class FileWritingTaskRepository implements WritingTaskRepository {
  constructor(private root: string) {}
  private dir(topicId: string, version: number) {
    return join(this.root, safe(topicId), `v${version}`);
  }
  async write(
    topicId: string,
    researchVersion: number,
    files: Record<string, string>,
  ) {
    const dir = this.dir(topicId, researchVersion);
    for (const [name, body] of Object.entries(files))
      await secureText(join(dir, name), body);
    return dir;
  }
  async readInput(topicId: string, researchVersion: number) {
    try {
      return JSON.parse(
        await readFile(
          join(this.dir(topicId, researchVersion), "writing-input.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
}
export class FileWritingGateRepository implements WritingGateRepository {
  private telegram: FileTelegramRepository;
  constructor(telegramRoot: string) {
    this.telegram = new FileTelegramRepository(telegramRoot);
  }
  async event(id: string) {
    return (await this.telegram.listApprovedEvents()).find((x) => x.id === id);
  }
  queue(topicId: string) {
    return this.telegram.getQueueItem(topicId);
  }
}
