import { mkdir, readFile, readdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeAtomicJson } from "../discovery/persistence";
import {
  articleFinalApprovedEventSchema,
  type ArticleFinalApprovedEvent,
} from "../review/models";
import { sha256 } from "../writing/task";
import type {
  PublicationJobRepository,
  PublicationRepository,
  FinalApprovedEventConsumerRepository,
  DeploymentStatusRepository,
  PublicationVerificationRepository,
  PublicationRepublishRepository,
  ProductionPublicationArtifactRepository,
  FinalApprovedEventSource,
} from "./interfaces";
import {
  consumptionRecordSchema,
  deploymentRecordSchema,
  publicationJobSchema,
  publicationRecordSchema,
  publicationVerificationSchema,
  publicationRepublishRecordSchema,
  productionPublicationArtifactSchema,
  type ConsumptionRecord,
  type DeploymentRecord,
  type PublicationJob,
  type PublicationRecord,
  type PublicationVerification,
  type PublicationRepublishRecord,
  type ProductionPublicationArtifact,
} from "./models";

const safe = (x: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(x)) throw new Error("Unsafe identifier");
  return x;
};
const missing = (e: unknown) =>
  e instanceof Error &&
  "code" in e &&
  (e as NodeJS.ErrnoException).code === "ENOENT";
async function optional<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if (missing(e)) return;
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
async function names(path: string) {
  try {
    return await readdir(path);
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
}

export class FilePublicationJobRepository implements PublicationJobRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "jobs", `${safe(id)}.json`);
  }
  get(eventId: string) {
    return optional(this.path(eventId), publicationJobSchema);
  }
  async claim(
    event: ArticleFinalApprovedEvent,
    workerId: string,
    now: string,
    staleAfterMs: number,
  ) {
    const old = await this.get(event.id);
    if (
      old &&
      !["failed", "blocked"].includes(old.status) &&
      Date.parse(now) - Date.parse(old.heartbeatAt) <= staleAfterMs
    )
      return old;
    const job = publicationJobSchema.parse({
      id: `publicationjob_${sha256(event.id).slice(0, 24)}`,
      finalApprovedEventId: event.id,
      topicId: event.topicId,
      draftId: event.draftId,
      draftVersion: event.draftVersion,
      reviewId: event.reviewId,
      reviewVersion: event.reviewVersion,
      attempt: (old?.attempt ?? 0) + 1,
      status: "claimed",
      startedAt: old?.startedAt ?? now,
      heartbeatAt: now,
      workerId,
      version: (old?.version ?? 0) + 1,
    });
    await writeAtomicJson(this.path(event.id), job);
    return job;
  }
  save(job: PublicationJob) {
    return writeAtomicJson(
      this.path(job.finalApprovedEventId),
      publicationJobSchema.parse(job),
    );
  }
}
export class FilePublicationRepository implements PublicationRepository {
  constructor(private root: string) {}
  private dir(id: string) {
    return join(this.root, "publications", safe(id));
  }
  async getByEvent(eventId: string) {
    for (const id of await names(join(this.root, "publications"))) {
      const x = await this.latest(id);
      if (x?.finalApprovedEventId === eventId) return x;
    }
  }
  async getByTopic(topicId: string) {
    for (const id of await names(join(this.root, "publications"))) {
      const x = await this.latest(id);
      if (x?.topicId === topicId) return x;
    }
  }
  private async latest(id: string) {
    const index = await optional(
      join(this.dir(id), "index.json"),
      z.object({ latestVersion: z.number().int().positive() }),
    );
    return index
      ? optional(
          join(this.dir(id), `v${index.latestVersion}.json`),
          publicationRecordSchema,
        )
      : undefined;
  }
  async save(record: PublicationRecord) {
    const x = publicationRecordSchema.parse(record);
    const path = join(this.dir(x.id), `v${x.version}.json`);
    if (!(await exclusive(path, x))) {
      const old = await optional(path, publicationRecordSchema);
      if (JSON.stringify(old) !== JSON.stringify(x))
        throw new Error("Publication version conflict");
    }
    await writeAtomicJson(join(this.dir(x.id), "index.json"), {
      latestVersion: x.version,
      status: x.status,
      updatedAt: x.updatedAt,
    });
  }
  async list() {
    const out: PublicationRecord[] = [];
    for (const id of await names(join(this.root, "publications"))) {
      const x = await this.latest(id);
      if (x) out.push(x);
    }
    return out;
  }
}
export class FilePublicationRepublishRepository implements PublicationRepublishRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "republishes", `${safe(id)}.json`);
  }
  async getByIdempotencyKey(idempotencyKey: string) {
    return (await this.list()).find(
      (record) => record.idempotencyKey === idempotencyKey,
    );
  }
  async getById(id: string) {
    return optional(this.path(id), publicationRepublishRecordSchema);
  }
  async save(record: PublicationRepublishRecord) {
    const value = publicationRepublishRecordSchema.parse(record);
    if (!(await exclusive(this.path(value.id), value))) {
      const old = await optional(
        this.path(value.id),
        publicationRepublishRecordSchema,
      );
      if (JSON.stringify(old) !== JSON.stringify(value))
        throw new Error("Republish record is immutable");
    }
  }
  async list() {
    const out: PublicationRepublishRecord[] = [];
    for (const name of await names(join(this.root, "republishes"))) {
      const value = await optional(
        join(this.root, "republishes", name),
        publicationRepublishRecordSchema,
      );
      if (value) out.push(value);
    }
    return out;
  }
}
export class FileProductionPublicationArtifactRepository implements ProductionPublicationArtifactRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "production-artifacts", `${safe(id)}.json`);
  }
  getById(id: string) {
    return optional(this.path(id), productionPublicationArtifactSchema);
  }
  async getByRepublishId(republishId: string) {
    return (await this.list()).find(
      (record) => record.republishId === republishId,
    );
  }
  async save(record: ProductionPublicationArtifact) {
    const value = productionPublicationArtifactSchema.parse(record);
    if (!(await exclusive(this.path(value.id), value))) {
      const old = await optional(
        this.path(value.id),
        productionPublicationArtifactSchema,
      );
      if (JSON.stringify(old) !== JSON.stringify(value))
        throw new Error("Production publication artifact is immutable");
    }
  }
  async list() {
    const out: ProductionPublicationArtifact[] = [];
    for (const name of await names(join(this.root, "production-artifacts"))) {
      const value = await optional(
        join(this.root, "production-artifacts", name),
        productionPublicationArtifactSchema,
      );
      if (value) out.push(value);
    }
    return out.sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt));
  }
}
export class FileEventConsumerRepository implements FinalApprovedEventConsumerRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "consumption", `${safe(id)}.json`);
  }
  get(id: string) {
    return optional(this.path(id), consumptionRecordSchema);
  }
  async consume(record: ConsumptionRecord) {
    return exclusive(
      this.path(record.finalApprovedEventId),
      consumptionRecordSchema.parse(record),
    );
  }
}
export class FileDeploymentStatusRepository implements DeploymentStatusRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "deployments", `${safe(id)}.json`);
  }
  get(id: string) {
    return optional(this.path(id), deploymentRecordSchema);
  }
  save(x: DeploymentRecord) {
    return writeAtomicJson(
      this.path(x.publicationId),
      deploymentRecordSchema.parse(x),
    );
  }
}
export class FilePublicationVerificationRepository implements PublicationVerificationRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "verifications", `${safe(id)}.json`);
  }
  get(id: string) {
    return optional(this.path(id), publicationVerificationSchema);
  }
  save(x: PublicationVerification) {
    return writeAtomicJson(
      this.path(x.publicationId),
      publicationVerificationSchema.parse(x),
    );
  }
}
export class FileFinalApprovedEventSource implements FinalApprovedEventSource {
  constructor(private root: string) {}
  async all() {
    const out: ArticleFinalApprovedEvent[] = [];
    for (const topic of await names(this.root)) {
      const index = await optional(
        join(this.root, topic, "index.json"),
        z.object({ latestVersion: z.number().int().positive() }),
      );
      if (index) {
        const x = await optional(
          join(this.root, topic, `v${index.latestVersion}.json`),
          articleFinalApprovedEventSchema,
        );
        if (x) out.push(x);
      }
    }
    return out;
  }
  async getById(id: string) {
    return (await this.all()).find((x) => x.id === id);
  }
  async due(now: string) {
    return (await this.all()).filter(
      (x) =>
        x.status === "scheduled" &&
        Boolean(x.requestedPublishAt) &&
        Date.parse(x.requestedPublishAt!) <= Date.parse(now),
    );
  }
  async next(now: string) {
    return (await this.all())
      .filter(
        (x) =>
          x.status === "ready_for_publication" ||
          (x.status === "scheduled" &&
            Boolean(x.requestedPublishAt) &&
            Date.parse(x.requestedPublishAt!) <= Date.parse(now)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }
}
