import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAtomicJson } from "../discovery/persistence";
import { sha256 } from "../writing/task";
import type { ProductionPublicationArtifact } from "../publication/models";
import type {
  SocialApprovalRepository,
  SocialExportRepository,
  SocialGenerationJobRepository,
  SocialHistoryRepository,
  SocialPackageRepository,
  SocialPostedRepository,
  SocialQualityRepository,
  SocialRevisionRepository,
  SocialTaskRepository,
  SocialConversationRepository,
  SocialAssetRepository,
  SocialDistributionPlanRepository,
} from "./interfaces";
import {
  postedRecordSchema,
  socialApprovalSchema,
  socialExportSchema,
  socialHistorySchema,
  socialJobSchema,
  socialPackageSchema,
  socialQualitySchema,
  socialRevisionSchema,
  socialConversationSchema,
  type PostedRecord,
  type SocialApproval,
  type SocialExport,
  type SocialGenerationJob,
  type SocialHistory,
  type SocialPackage,
  type SocialQuality,
  type SocialRevision,
  type SocialConversation,
  socialAssetSchema,
  socialDistributionEventSchema,
  socialDistributionPlanSchema,
  type SocialAsset,
  type SocialDistributionEvent,
  type SocialDistributionPlan,
} from "./models";
const safe = (x: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(x)) throw new Error("Unsafe identifier");
  return x;
};
const safeFile = (x: string) => {
  if (!/^[A-Za-z0-9_.-]+$/.test(x) || x.includes(".."))
    throw new Error("Unsafe filename");
  return x;
};
const missing = (e: unknown) =>
  e instanceof Error &&
  "code" in e &&
  (e as NodeJS.ErrnoException).code === "ENOENT";
async function optional<T>(path: string, schema: z.ZodType<T>) {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if (missing(e)) return;
    throw e;
  }
}
async function names(path: string) {
  try {
    return (await readdir(path)).sort();
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
}
async function exclusive(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const h = await open(path, "wx", 0o600);
    try {
      await h.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    } finally {
      await h.close();
    }
    return true;
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as NodeJS.ErrnoException).code === "EEXIST"
    )
      return false;
    throw e;
  }
}
async function secure(path: string, body: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw e;
  }
}
export class FileSocialDistributionPlanRepository implements SocialDistributionPlanRepository {
  constructor(private root: string) {}
  private dir(id: string) {
    return join(this.root, "distribution-plans", safe(id));
  }
  async get(id: string) {
    const index = await optional(
      join(this.dir(id), "index.json"),
      z.object({ version: z.number().int().positive() }),
    );
    return index
      ? optional(
          join(this.dir(id), `v${index.version}.json`),
          socialDistributionPlanSchema,
        )
      : undefined;
  }
  async getByPublication(publicationId: string) {
    const id = `socialplan_${sha256(publicationId).slice(0, 24)}`;
    return this.get(id);
  }
  async getByShortId(shortId: string) {
    if (!/^[a-f0-9]{12}$/.test(shortId)) return undefined;
    for (const id of await names(join(this.root, "distribution-plans")))
      if (id.endsWith(shortId)) return this.get(id);
    return undefined;
  }
  async save(plan: SocialDistributionPlan) {
    const value = socialDistributionPlanSchema.parse(plan);
    const current = await this.get(value.id);
    if (current && value.version <= current.version) {
      if (JSON.stringify(current) === JSON.stringify(value)) return;
      throw new Error("Social distribution plan version conflict");
    }
    if (
      !(await exclusive(
        join(this.dir(value.id), `v${value.version}.json`),
        value,
      ))
    )
      throw new Error("Social distribution plan snapshot conflict");
    await writeAtomicJson(join(this.dir(value.id), "index.json"), {
      version: value.version,
      publicationId: value.publicationId,
      status: value.status,
      updatedAt: value.updatedAt,
    });
  }
  async appendEvent(event: SocialDistributionEvent) {
    const value = socialDistributionEventSchema.parse(event);
    return exclusive(
      join(
        this.dir(value.planId),
        "events",
        `${String(value.sequence).padStart(6, "0")}-${safe(value.id)}.json`,
      ),
      value,
    );
  }
  async listEvents(planId: string) {
    const out: SocialDistributionEvent[] = [];
    for (const name of await names(join(this.dir(planId), "events"))) {
      const event = await optional(
        join(this.dir(planId), "events", name),
        socialDistributionEventSchema,
      );
      if (event) out.push(event);
    }
    return out.sort((a, b) => a.sequence - b.sequence);
  }
}

export class FileSocialAssetRepository implements SocialAssetRepository {
  constructor(private root: string) {}
  private metadataPath(id: string) {
    return join(this.root, "asset-records", `${safe(id)}.json`);
  }
  async findByContentHash(planId: string, contentHash: string) {
    return (await this.list(planId)).find(
      (asset) => asset.contentHash === contentHash,
    );
  }
  async save(asset: SocialAsset, bytes: Uint8Array) {
    const parsed = socialAssetSchema.parse(asset);
    const filename = parsed.path.split("/").at(-1) ?? `${parsed.id}.png`;
    const path = join(
      this.root,
      "exports",
      safe(parsed.publicationId),
      `v${parsed.packageVersion}`,
      safe(parsed.platform),
      safeFile(filename),
    );
    const value = socialAssetSchema.parse({ ...parsed, path });
    const existing = await optional(
      this.metadataPath(value.id),
      socialAssetSchema,
    );
    if (existing) {
      if (existing.contentHash !== value.contentHash)
        throw new Error("Social asset identity conflict");
      return existing;
    }
    await secure(path, bytes);
    if (!(await exclusive(this.metadataPath(value.id), value)))
      throw new Error("Social asset metadata conflict");
    return value;
  }
  async list(planId: string) {
    const out: SocialAsset[] = [];
    for (const name of await names(join(this.root, "asset-records"))) {
      const value = await optional(
        join(this.root, "asset-records", name),
        socialAssetSchema,
      );
      if (value?.planId === planId) out.push(value);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(assetId: string) {
    const value = await optional(this.metadataPath(assetId), socialAssetSchema);
    if (!value) return undefined;
    try {
      return await readFile(value.path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
}
export class FileSocialJobRepository implements SocialGenerationJobRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "jobs", `${safe(id)}.json`);
  }
  get(id: string) {
    return optional(this.path(id), socialJobSchema);
  }
  async claim(
    record: ProductionPublicationArtifact,
    workerId: string,
    now: string,
  ) {
    const old = await this.get(record.id);
    if (old && !["failed", "blocked", "cancelled"].includes(old.status))
      return old;
    const value = socialJobSchema.parse({
      id: `socialjob_${sha256(record.id).slice(0, 24)}`,
      publicationId: record.id,
      topicId: record.topicId,
      articleSlug: record.slug,
      articleContentHash: record.contentHash,
      attempt: (old?.attempt ?? 0) + 1,
      status: "claimed",
      startedAt: old?.startedAt ?? now,
      heartbeatAt: now,
      workerId,
      version: (old?.version ?? 0) + 1,
    });
    await writeAtomicJson(this.path(record.id), value);
    return value;
  }
  save(x: SocialGenerationJob) {
    return writeAtomicJson(
      this.path(x.publicationId),
      socialJobSchema.parse(x),
    );
  }
}
export class FileSocialPackageRepository implements SocialPackageRepository {
  constructor(private root: string) {}
  private dir(id: string, v: number) {
    return join(this.root, "packages", safe(id), `v${v}`);
  }
  async nextVersion(id: string) {
    const xs = await names(join(this.root, "packages", safe(id)));
    return (
      Math.max(0, ...xs.map((x) => Number(/^v(\d+)$/.exec(x)?.[1] ?? 0))) + 1
    );
  }
  async get(id: string, v?: number) {
    if (!v)
      v = (
        await optional(
          join(this.root, "packages", safe(id), "index.json"),
          z.object({ latestVersion: z.number().int().positive() }),
        )
      )?.latestVersion;
    return v
      ? optional(join(this.dir(id, v), "package.json"), socialPackageSchema)
      : undefined;
  }
  async findByImportHash(hash: string) {
    for (const id of await names(join(this.root, "packages"))) {
      for (const v of await names(join(this.root, "packages", id))) {
        const n = Number(/^v(\d+)$/.exec(v)?.[1]);
        if (n) {
          const x = await this.get(id, n);
          if (x?.provenance.importHash === hash) return x;
        }
      }
    }
  }
  async save(
    pkg: SocialPackage,
    quality: SocialQuality[],
    provenance: unknown,
  ) {
    const value = socialPackageSchema.parse(pkg),
      dir = this.dir(value.publicationId, value.version),
      stage = `${dir}.stage-${randomUUID()}`;
    try {
      await mkdir(join(stage, "quality"), { recursive: true });
      await writeAtomicJson(join(stage, "package.json"), value);
      await writeAtomicJson(join(stage, "import-provenance.json"), provenance);
      for (const q of quality)
        await writeAtomicJson(
          join(stage, "quality", `${safe(q.platformItemId)}.json`),
          socialQualitySchema.parse(q),
        );
      await rename(stage, dir);
      await writeAtomicJson(
        join(this.root, "packages", safe(value.publicationId), "index.json"),
        {
          packageId: value.id,
          latestVersion: value.version,
          status: value.status,
          updatedAt: value.updatedAt,
        },
      );
    } catch (e) {
      await rm(stage, { recursive: true, force: true });
      throw e;
    }
  }
  async getQuality(id: string, v: number) {
    const dir = join(this.dir(id, v), "quality");
    const out = [];
    for (const name of await names(dir)) {
      const q = await optional(join(dir, name), socialQualitySchema);
      if (q) out.push(q);
    }
    return out;
  }
}
export class FileSocialApprovalRepository implements SocialApprovalRepository {
  constructor(private root: string) {}
  private dir(pid: string, iid: string) {
    return join(this.root, "approvals", safe(pid), safe(iid));
  }
  async get(pid: string, iid: string) {
    const xs = await names(this.dir(pid, iid));
    const v = Math.max(
      0,
      ...xs.map((x) => Number(/^v(\d+)\.json$/.exec(x)?.[1] ?? 0)),
    );
    return v
      ? optional(join(this.dir(pid, iid), `v${v}.json`), socialApprovalSchema)
      : undefined;
  }
  async save(x: SocialApproval) {
    const v = socialApprovalSchema.parse(x);
    if (
      !(await exclusive(
        join(this.dir(v.packageId, v.platformItemId), `v${v.version}.json`),
        v,
      ))
    )
      throw new Error("Social approval version conflict");
  }
  async list(pid: string) {
    const out: SocialApproval[] = [];
    for (const iid of await names(join(this.root, "approvals", safe(pid)))) {
      const x = await this.get(pid, iid);
      if (x) out.push(x);
    }
    return out;
  }
}
export class FileSocialHistoryRepository implements SocialHistoryRepository {
  constructor(private root: string) {}
  private path() {
    return join(this.root, "history", "social.json");
  }
  async list() {
    return (await optional(this.path(), z.array(socialHistorySchema))) ?? [];
  }
  async add(x: SocialHistory) {
    const old = await this.list();
    if (
      old.some(
        (y) => y.contentHash === x.contentHash && y.platform === x.platform,
      )
    )
      return;
    await writeAtomicJson(this.path(), [...old, socialHistorySchema.parse(x)]);
  }
}
export class FileSocialExportRepository implements SocialExportRepository {
  constructor(private root: string) {}
  private dir(id: string, v: number) {
    return join(this.root, "exports", safe(id), `v${v}`);
  }
  private recordsPath(id: string, v: number) {
    return join(this.root, "export-records", safe(id), `v${v}.json`);
  }
  async write(
    id: string,
    v: number,
    files: Record<string, string>,
    records: SocialExport[],
  ) {
    for (const [name, body] of Object.entries(files))
      await secure(join(this.dir(id, v), name), body);
    const previous = await this.list(id, v);
    const merged = [...previous];
    for (const record of records) {
      const index = merged.findIndex((value) => value.id === record.id);
      if (index >= 0) merged[index] = record;
      else merged.push(record);
    }
    await writeAtomicJson(
      this.recordsPath(id, v),
      merged.map((x) => socialExportSchema.parse(x)),
    );
    return merged;
  }
  async list(id: string, v: number) {
    return (
      (await optional(this.recordsPath(id, v), z.array(socialExportSchema))) ??
      []
    );
  }
  async readFiles(id: string, v: number) {
    const files: Record<string, string> = {};
    for (const name of await names(this.dir(id, v))) {
      const path = join(this.dir(id, v), name);
      if ((await stat(path)).isFile())
        files[name] = await readFile(path, "utf8");
    }
    return files;
  }
  location(id: string, v: number) {
    return resolve(this.dir(id, v));
  }
}
export class FileSocialTaskRepository implements SocialTaskRepository {
  constructor(private root: string) {}
  private dir(id: string, v: number) {
    return join(this.root, safe(id), `v${v}`);
  }
  async write(id: string, v: number, files: Record<string, string>) {
    const dir = this.dir(id, v);
    for (const [n, b] of Object.entries(files)) await secure(join(dir, n), b);
    return dir;
  }
  async readInput(id: string, v: number) {
    try {
      return JSON.parse(
        await readFile(join(this.dir(id, v), "social-input.json"), "utf8"),
      ) as unknown;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
}
export class FileSocialQualityRepository implements SocialQualityRepository {
  constructor(private packages: FileSocialPackageRepository) {}
  get(id: string, version: number) {
    return this.packages.getQuality(id, version);
  }
}
export class FileSocialPostedRepository implements SocialPostedRepository {
  constructor(private root: string) {}
  private path(id: string, p: string) {
    return join(this.root, "posted", safe(id), `${safe(p)}.json`);
  }
  save(x: PostedRecord) {
    return writeAtomicJson(
      this.path(x.publicationId, x.platform),
      postedRecordSchema.parse(x),
    );
  }
  get(id: string, p: string) {
    return optional(this.path(id, p), postedRecordSchema);
  }
}
export class FileSocialConversationRepository implements SocialConversationRepository {
  constructor(private root: string) {}
  private path(chatId: string, userId: string) {
    return join(
      this.root,
      "conversations",
      `${safe(chatId)}_${safe(userId)}.json`,
    );
  }
  get(chatId: string, userId: string) {
    return optional(this.path(chatId, userId), socialConversationSchema);
  }
  save(value: SocialConversation) {
    const parsed = socialConversationSchema.parse(value);
    return writeAtomicJson(this.path(parsed.chatId, parsed.userId), parsed);
  }
  async clear(chatId: string, userId: string) {
    await unlink(this.path(chatId, userId)).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}
export class FileSocialRevisionRepository implements SocialRevisionRepository {
  constructor(private root: string) {}
  private dir(id: string, v: number) {
    return join(this.root, safe(id), `package-v${v}`);
  }
  async write(
    id: string,
    v: number,
    files: Record<string, string>,
    request: SocialRevision,
  ) {
    const dir = this.dir(id, v);
    for (const [n, b] of Object.entries(files)) await secure(join(dir, n), b);
    await writeAtomicJson(
      join(dir, "request.json"),
      socialRevisionSchema.parse(request),
    );
    return dir;
  }
  get(id: string, v: number) {
    return optional(
      join(this.dir(id, v), "request.json"),
      socialRevisionSchema,
    );
  }
}
