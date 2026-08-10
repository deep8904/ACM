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
import { FileResearchPacketRepository } from "../research/storage";
import { FileTelegramRepository } from "../telegram/file-repository";
import { FileArticleDraftRepository } from "../writing/storage";
import type { ArticleDraft } from "../writing/models";
import { sha256 } from "../writing/task";
import type {
  DraftPreviewRepository,
  EditorialIssueRepository,
  EditorialReviewJobRepository,
  EditorialReviewRepository,
  FinalApprovedEventRepository,
  FinalApprovalRepository,
  FinalConversationRepository,
  ReviewGateRepository,
  ReviewTaskRepository,
  RevisionTaskRepository,
} from "./interfaces";
import {
  articleFinalApprovedEventSchema,
  deterministicEditorialReportSchema,
  draftPreviewSchema,
  editorialReviewJobSchema,
  editorialReviewResultSchema,
  finalApprovalRecordSchema,
  finalConversationStateSchema,
  revisionRequestSchema,
  type ArticleFinalApprovedEvent,
  type DeterministicEditorialReport,
  type DraftPreview,
  type EditorialReviewJob,
  type EditorialReviewResult,
  type FinalApprovalRecord,
  type FinalConversationState,
  type RevisionRequest,
} from "./models";

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
async function files(path: string) {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
async function secureText(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
async function exclusiveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await import("node:fs/promises").then((fs) =>
      fs.open(path, "wx", 0o600),
    );
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

export class FileEditorialReviewJobRepository implements EditorialReviewJobRepository {
  constructor(private root: string) {}
  private path(topicId: string, draftVersion: number) {
    return join(
      this.root,
      "jobs",
      `${safe(topicId)}_draft-v${draftVersion}.json`,
    );
  }
  async claim(draft: ArticleDraft, workerId: string, now: string) {
    const old = await this.get(draft.topicId, draft.version);
    if (old && !["failed", "blocked", "cancelled"].includes(old.status))
      return old;
    const value = editorialReviewJobSchema.parse({
      id: `reviewjob_${sha256(`${draft.id}:${draft.version}`).slice(0, 24)}`,
      topicId: draft.topicId,
      draftId: draft.id,
      draftVersion: draft.version,
      researchPacketId: draft.researchPacketId,
      researchPacketVersion: draft.researchPacketVersion,
      attempt: (old?.attempt ?? 0) + 1,
      status: "claimed",
      startedAt: now,
      heartbeatAt: now,
      workerId,
      version: (old?.version ?? 0) + 1,
    });
    await writeAtomicJson(this.path(draft.topicId, draft.version), value);
    return value;
  }
  get(topicId: string, draftVersion: number) {
    return optional(this.path(topicId, draftVersion), editorialReviewJobSchema);
  }
  async getById(id: string) {
    for (const name of await files(join(this.root, "jobs"))) {
      const value = await optional(
        join(this.root, "jobs", name),
        editorialReviewJobSchema,
      );
      if (value?.id === id) return value;
    }
    return undefined;
  }
  save(job: EditorialReviewJob) {
    return writeAtomicJson(
      this.path(job.topicId, job.draftVersion),
      editorialReviewJobSchema.parse(job),
    );
  }
}
export class FileEditorialReviewRepository
  implements EditorialReviewRepository, EditorialIssueRepository
{
  constructor(private root: string) {}
  private dir(topicId: string, draftVersion: number) {
    return join(this.root, "reviews", safe(topicId), `draft-v${draftVersion}`);
  }
  async nextVersion(topicId: string, draftVersion: number) {
    return (
      Math.max(
        0,
        ...(await files(this.dir(topicId, draftVersion))).map((x) =>
          Number(/^review-v(\d+)$/.exec(x)?.[1] ?? 0),
        ),
      ) + 1
    );
  }
  async get(topicId: string, draftVersion: number, reviewVersion?: number) {
    if (!reviewVersion)
      reviewVersion = (
        await optional(
          join(this.dir(topicId, draftVersion), "index.json"),
          z.object({ latestVersion: z.number().int().positive() }),
        )
      )?.latestVersion;
    const review = reviewVersion
      ? await optional(
          join(
            this.dir(topicId, draftVersion),
            `review-v${reviewVersion}`,
            "review.json",
          ),
          editorialReviewResultSchema,
        )
      : undefined;
    if (!review) return undefined;
    const resolutions = await this.resolutions(topicId, draftVersion);
    return editorialReviewResultSchema.parse({
      ...review,
      issues: review.issues.map((issue) => {
        const resolution = resolutions.find((x) =>
          x.issueIds.includes(issue.id),
        );
        return resolution
          ? {
              ...issue,
              status: "resolved",
              resolvedAt: resolution.resolvedAt,
              resolutionNotes: `Resolved by immutable draft v${resolution.revisedDraftVersion}`,
            }
          : issue;
      }),
    });
  }
  async findByImportHash(hash: string) {
    for (const topic of await files(join(this.root, "reviews")))
      for (const draftDir of await files(join(this.root, "reviews", topic))) {
        const version = Number(/^draft-v(\d+)$/.exec(draftDir)?.[1]);
        if (version) {
          for (const reviewDir of await files(
            join(this.root, "reviews", topic, draftDir),
          )) {
            const reviewVersion = Number(
              /^review-v(\d+)$/.exec(reviewDir)?.[1],
            );
            if (!reviewVersion) continue;
            const review = await this.get(topic, version, reviewVersion);
            if (review?.provenance.importHash === hash) return review;
          }
        }
      }
    return undefined;
  }
  async save(
    review: EditorialReviewResult,
    deterministic: DeterministicEditorialReport,
    provenance: unknown,
  ) {
    const value = editorialReviewResultSchema.parse(review);
    const finalDir = join(
      this.dir(value.topicId ?? "", value.draftVersion),
      `review-v${value.version}`,
    );
    const stage = `${finalDir}.stage-${randomUUID()}`;
    try {
      await mkdir(stage, { recursive: true });
      await Promise.all([
        writeAtomicJson(join(stage, "review.json"), value),
        writeAtomicJson(
          join(stage, "deterministic-report.json"),
          deterministicEditorialReportSchema.parse(deterministic),
        ),
        writeAtomicJson(join(stage, "import-provenance.json"), provenance),
        writeAtomicJson(join(stage, "issues.json"), value.issues),
      ]);
      await rename(stage, finalDir);
      await writeAtomicJson(
        join(this.dir(value.topicId ?? "", value.draftVersion), "index.json"),
        {
          reviewId: value.id,
          latestVersion: value.version,
          decision: value.decision,
          updatedAt: value.provenance.importedAt,
        },
      );
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
  async list(topicId: string, draftVersion: number, reviewVersion?: number) {
    return (await this.get(topicId, draftVersion, reviewVersion))?.issues ?? [];
  }
  async resolveIssues(
    topicId: string,
    draftVersion: number,
    issueIds: string[],
    revisedDraftVersion: number,
    resolvedAt: string,
  ) {
    const value = {
      topicId,
      draftVersion,
      issueIds: [...new Set(issueIds)].sort(),
      revisedDraftVersion,
      resolvedAt,
    };
    const id = sha256(JSON.stringify(value)).slice(0, 24);
    await exclusiveJson(
      join(
        this.root,
        "issue-resolutions",
        safe(topicId),
        `draft-v${draftVersion}`,
        `${id}.json`,
      ),
      value,
    );
  }
  private async resolutions(topicId: string, draftVersion: number) {
    const schema = z
      .object({
        topicId: z.string(),
        draftVersion: z.number().int().positive(),
        issueIds: z.array(z.string()),
        revisedDraftVersion: z.number().int().positive(),
        resolvedAt: z.string().datetime({ offset: true }),
      })
      .strict();
    const dir = join(
      this.root,
      "issue-resolutions",
      safe(topicId),
      `draft-v${draftVersion}`,
    );
    return Promise.all(
      (await files(dir)).map((name) => optional(join(dir, name), schema)),
    ).then((values) =>
      values.filter((x): x is z.infer<typeof schema> => Boolean(x)),
    );
  }
}
export class FileReviewTaskRepository implements ReviewTaskRepository {
  constructor(private root: string) {}
  private dir(topicId: string, version: number) {
    return join(this.root, safe(topicId), `draft-v${version}`);
  }
  async write(
    topicId: string,
    version: number,
    values: Record<string, string>,
  ) {
    const dir = this.dir(topicId, version);
    for (const [name, body] of Object.entries(values))
      await secureText(join(dir, name), body);
    return dir;
  }
  async readInput(topicId: string, version: number) {
    try {
      return JSON.parse(
        await readFile(
          join(this.dir(topicId, version), "review-input.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
}
export class FileRevisionTaskRepository implements RevisionTaskRepository {
  constructor(private root: string) {}
  private dir(topicId: string, version: number) {
    return join(this.root, safe(topicId), `draft-v${version}`);
  }
  async write(
    topicId: string,
    version: number,
    values: Record<string, string>,
  ) {
    const dir = this.dir(topicId, version);
    for (const [name, body] of Object.entries(values))
      await secureText(join(dir, name), body);
    return dir;
  }
  async readInput(topicId: string, version: number) {
    try {
      return JSON.parse(
        await readFile(
          join(this.dir(topicId, version), "revision-input.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  saveRequest(request: RevisionRequest) {
    return writeAtomicJson(
      join(
        this.root,
        "requests",
        safe(request.topicId),
        `draft-v${request.draftVersion}.json`,
      ),
      revisionRequestSchema.parse(request),
    );
  }
  getRequest(topicId: string, version: number) {
    return optional(
      join(this.root, "requests", safe(topicId), `draft-v${version}.json`),
      revisionRequestSchema,
    );
  }
  saveResolution(
    topicId: string,
    draftVersion: number,
    issueIds: string[],
    revisedDraftVersion: number,
    resolvedAt: string,
  ) {
    return writeAtomicJson(
      join(
        this.root,
        "resolutions",
        safe(topicId),
        `draft-v${draftVersion}.json`,
      ),
      { topicId, draftVersion, issueIds, revisedDraftVersion, resolvedAt },
    );
  }
}
export class FileFinalApprovalRepository implements FinalApprovalRepository {
  constructor(private root: string) {}
  private dir(topicId: string) {
    return join(this.root, "approvals", safe(topicId));
  }
  async get(topicId: string, version?: number) {
    if (!version)
      version = (
        await optional(
          join(this.dir(topicId), "index.json"),
          z.object({ latestVersion: z.number().int().positive() }),
        )
      )?.latestVersion;
    return version
      ? optional(
          join(this.dir(topicId), `v${version}.json`),
          finalApprovalRecordSchema,
        )
      : undefined;
  }
  async getByShortId(shortId: string) {
    return (await this.list()).find((x) => x.shortId === shortId);
  }
  async save(record: FinalApprovalRecord) {
    const value = finalApprovalRecordSchema.parse(record);
    if (
      !(await exclusiveJson(
        join(this.dir(value.topicId), `v${value.version}.json`),
        value,
      ))
    ) {
      const old = await this.get(value.topicId, value.version);
      if (JSON.stringify(old) !== JSON.stringify(value))
        throw new Error("Final approval version already exists");
    }
    await writeAtomicJson(join(this.dir(value.topicId), "index.json"), {
      approvalId: value.id,
      latestVersion: value.version,
      status: value.status,
      updatedAt: value.updatedAt,
    });
  }
  async list() {
    const values = [];
    for (const topic of await files(join(this.root, "approvals"))) {
      const value = await this.get(topic);
      if (value) values.push(value);
    }
    return values;
  }
}
export class FileFinalApprovedEventRepository implements FinalApprovedEventRepository {
  constructor(private root: string) {}
  private dir(topicId: string) {
    return join(this.root, safe(topicId));
  }
  async get(topicId: string) {
    const version = (
      await optional(
        join(this.dir(topicId), "index.json"),
        z.object({ latestVersion: z.number().int().positive() }),
      )
    )?.latestVersion;
    return version
      ? optional(
          join(this.dir(topicId), `v${version}.json`),
          articleFinalApprovedEventSchema,
        )
      : undefined;
  }
  async save(event: ArticleFinalApprovedEvent) {
    const value = articleFinalApprovedEventSchema.parse(event);
    if (await this.get(value.topicId)) return false;
    const created = await exclusiveJson(
      join(this.dir(value.topicId), `v${value.version}.json`),
      value,
    );
    if (created)
      await writeAtomicJson(join(this.dir(value.topicId), "index.json"), {
        eventId: value.id,
        latestVersion: value.version,
        status: value.status,
        updatedAt: value.createdAt,
      });
    return created;
  }
  async update(event: ArticleFinalApprovedEvent, expectedVersion: number) {
    const current = await this.get(event.topicId);
    if (!current || current.version !== expectedVersion)
      throw new Error("Stale final-approved event version");
    const value = articleFinalApprovedEventSchema.parse(event);
    if (
      !(await exclusiveJson(
        join(this.dir(value.topicId), `v${value.version}.json`),
        value,
      ))
    )
      throw new Error("Final-approved event version already exists");
    await writeAtomicJson(join(this.dir(value.topicId), "index.json"), {
      eventId: value.id,
      latestVersion: value.version,
      status: value.status,
      updatedAt: value.createdAt,
    });
  }
}
export class FileDraftPreviewRepository implements DraftPreviewRepository {
  constructor(private root: string) {}
  private dir(topicId: string, version: number) {
    return join(this.root, safe(topicId), `draft-v${version}`);
  }
  async save(preview: DraftPreview, html: string) {
    const value = draftPreviewSchema.parse(preview);
    const path = join(
      this.dir(value.topicId, value.draftVersion),
      "preview.html",
    );
    await secureText(path, html);
    await writeAtomicJson(
      join(this.dir(value.topicId, value.draftVersion), "preview.json"),
      draftPreviewSchema.parse({ ...value, path }),
    );
    return path;
  }
  get(topicId: string, version: number) {
    return optional(
      join(this.dir(topicId, version), "preview.json"),
      draftPreviewSchema,
    );
  }
  async supersede(topicId: string, version: number, now: string) {
    const value = await this.get(topicId, version);
    if (!value || value.status !== "active") return;
    await writeAtomicJson(
      join(this.dir(topicId, version), "preview.json"),
      draftPreviewSchema.parse({
        ...value,
        status:
          Date.parse(value.expiresAt) <= Date.parse(now)
            ? "expired"
            : "superseded",
      }),
    );
  }
}
export class FileFinalConversationRepository implements FinalConversationRepository {
  constructor(private root: string) {}
  private path(chatId: string, userId: string) {
    return join(
      this.root,
      "conversations",
      `${safe(chatId.replace("-", "neg"))}_${safe(userId)}.json`,
    );
  }
  get(chatId: string, userId: string) {
    return optional(this.path(chatId, userId), finalConversationStateSchema);
  }
  save(value: FinalConversationState) {
    return writeAtomicJson(
      this.path(value.chatId, value.userId),
      finalConversationStateSchema.parse(value),
    );
  }
  async clear(chatId: string, userId: string) {
    await unlink(this.path(chatId, userId)).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

export class FileReviewGateRepository implements ReviewGateRepository {
  private packets: FileResearchPacketRepository;
  private drafts: FileArticleDraftRepository;
  private telegram: FileTelegramRepository;
  constructor(researchRoot: string, writingRoot: string, telegramRoot: string) {
    this.packets = new FileResearchPacketRepository(researchRoot);
    this.drafts = new FileArticleDraftRepository(writingRoot);
    this.telegram = new FileTelegramRepository(telegramRoot);
  }
  packet(topicId: string, version: number) {
    return this.packets.get(topicId, version);
  }
  quality(topicId: string, draftVersion: number) {
    return this.drafts.getQuality(topicId, draftVersion);
  }
  async topicActive(topicId: string, approvedEventId: string) {
    const [event, queue] = await Promise.all([
      this.telegram.getApprovedEventByTopicId(topicId),
      this.telegram.getQueueItem(topicId),
    ]);
    return Boolean(
      event?.id === approvedEventId &&
      event.status === "ready" &&
      event.consumed === false &&
      queue?.approvalStatus === "approved",
    );
  }
  async topicOrigin(topicId: string) {
    return (await this.telegram.getQueueItem(topicId))?.origin;
  }
}
