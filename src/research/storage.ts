import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z, type ZodType } from "zod";
import { writeAtomicJson } from "../discovery/persistence";
import { FileTelegramRepository } from "../telegram/file-repository";
import {
  topicApprovedEventSchema,
  type TopicApprovedEvent,
} from "../telegram/models";
import type {
  AssistedResearchImportRepository,
  ApprovedEventRepository,
  HumanAssistedEvidenceRecord,
  HumanAssistedEvidenceRepository,
  ResearchCacheRepository,
  ResearchJobRepository,
  ResearchPacketRepository,
  ResearchSourceRepository,
  ResearchSourceExtensionRepository,
  ResearchTaskRepository,
} from "./interfaces";
import {
  researchJobSchema,
  researchPacketSchema,
  researchSourceSchema,
  type ResearchJob,
  type ResearchPacket,
  type ResearchSource,
} from "./models";
import type { RetrievalDiagnosticCode } from "./retrieve";

const consumedSchema = z.object({
  eventId: z.string(),
  packetId: z.string(),
  packetVersion: z.number().positive(),
  consumedAt: z.string().datetime({ offset: true }),
});
export class FileResearchJobRepository implements ResearchJobRepository {
  constructor(private root: string) {}
  async claim(
    eventId: string,
    topicId: string,
    workerId: string,
    now: string,
    staleAfterMs: number,
    recoverableStatuses: readonly ResearchJob["status"][] = [
      "failed",
      "cancelled",
    ],
  ) {
    const path = join(this.root, "jobs", `${safe(eventId)}.json`);
    const old = await optional(path, researchJobSchema);
    if (
      old &&
      !recoverableStatuses.includes(old.status) &&
      Date.parse(now) - Date.parse(old.heartbeatAt) <= staleAfterMs
    )
      return undefined;
    const attempt = (old?.attempt ?? 0) + 1;
    const job = researchJobSchema.parse({
      id: stable("job", eventId),
      eventId,
      topicId,
      status: "claimed",
      attempt,
      claimedAt: now,
      heartbeatAt: now,
      workerId,
      retries: old
        ? [
            ...old.retries,
            { attempt, at: now, reason: `recovered ${old.status}` },
          ]
        : [],
      errors: old?.errors ?? [],
      version: (old?.version ?? 0) + 1,
    });
    if (!old && !(await exclusive(path, job))) return undefined;
    if (old) await writeAtomicJson(path, job);
    return job;
  }
  getByEvent(id: string) {
    return optional(
      join(this.root, "jobs", `${safe(id)}.json`),
      researchJobSchema,
    );
  }
  async getById(id: string) {
    try {
      for (const file of (await readdir(join(this.root, "jobs"))).filter((x) =>
        x.endsWith(".json"),
      )) {
        const job = await optional(
          join(this.root, "jobs", file),
          researchJobSchema,
        );
        if (job?.id === id) return job;
      }
      return undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  save(job: ResearchJob) {
    return writeAtomicJson(
      join(this.root, "jobs", `${safe(job.eventId)}.json`),
      researchJobSchema.parse(job),
    );
  }
}
export class FileResearchSourceRepository
  implements ResearchSourceRepository, ResearchCacheRepository
{
  constructor(private root: string) {}
  async save(source: ResearchSource, text: string) {
    const dir = join(
      this.root,
      "sources",
      safe(source.topicId),
      source.contentHash,
    );
    await writeAtomicJson(
      join(dir, "source.json"),
      researchSourceSchema.parse(source),
    );
    await secureText(join(dir, "extracted.txt"), text);
  }
  async list(topicId: string) {
    const dir = join(this.root, "sources", safe(topicId));
    try {
      return await Promise.all(
        (await readdir(dir))
          .sort()
          .map((name) =>
            optional(join(dir, name, "source.json"), researchSourceSchema),
          ),
      ).then((all) => all.filter((x): x is ResearchSource => Boolean(x)));
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
  async get(canonicalUrl: string) {
    const key = hash(canonicalUrl);
    const source = await optional(
      join(this.root, "cache", key, "source.json"),
      researchSourceSchema,
    );
    if (!source) return undefined;
    return {
      source,
      text: await readFile(
        join(this.root, "cache", key, "extracted.txt"),
        "utf8",
      ),
    };
  }
  async put(source: ResearchSource, text: string) {
    const dir = join(this.root, "cache", hash(source.canonicalUrl));
    await writeAtomicJson(join(dir, "source.json"), source);
    await secureText(join(dir, "extracted.txt"), text);
  }
  async getRobots(host: string) {
    return optional(
      join(this.root, "cache", "robots", `${hash(host)}.json`),
      z.object({
        body: z.string(),
        fetchedAt: z.string().datetime({ offset: true }),
      }),
    );
  }
  async putRobots(host: string, body: string, fetchedAt: string) {
    await writeAtomicJson(
      join(this.root, "cache", "robots", `${hash(host)}.json`),
      { body, fetchedAt },
    );
  }
  async claimRetrievalAttempt(input: {
    host: string;
    canonicalUrl: string;
    attemptedAt: string;
    budget: number;
    windowMs: number;
    cooldownMs: number;
  }) {
    const path = join(
      this.root,
      "cache",
      "retrieval-hosts",
      `${hash(input.host)}.json`,
    );
    const schema = z.object({
      attemptCount: z.number().int().nonnegative(),
      windowStartedAt: z.string().datetime({ offset: true }),
      cooldownUntil: z.string().datetime({ offset: true }).optional(),
    });
    const old = await optional(path, schema);
    const at = Date.parse(input.attemptedAt);
    if (old?.cooldownUntil && Date.parse(old.cooldownUntil) > at)
      return { allowed: false, retryAt: old.cooldownUntil };
    const inWindow =
      old && at - Date.parse(old.windowStartedAt) < input.windowMs;
    const attemptCount = inWindow ? old.attemptCount + 1 : 1;
    if (attemptCount > input.budget) {
      const retryAt = new Date(at + input.cooldownMs).toISOString();
      await writeAtomicJson(path, {
        attemptCount,
        windowStartedAt: inWindow ? old.windowStartedAt : input.attemptedAt,
        cooldownUntil: retryAt,
      });
      return { allowed: false, retryAt };
    }
    await writeAtomicJson(path, {
      attemptCount,
      windowStartedAt: inWindow ? old.windowStartedAt : input.attemptedAt,
    });
    return { allowed: true };
  }
  async getRetrievalOutcome(canonicalUrl: string, at: string) {
    const value = await optional(
      join(
        this.root,
        "cache",
        "retrieval-outcomes",
        `${hash(canonicalUrl)}.json`,
      ),
      z.object({
        code: z.enum([
          "429_retry_after",
          "429_cooldown",
          "robots_denied",
          "403_forbidden",
          "alternate_official_found",
          "no_retrievable_primary",
        ]),
        retryAt: z.string().datetime({ offset: true }).optional(),
        expiresAt: z.string().datetime({ offset: true }),
      }),
    );
    return value && Date.parse(value.expiresAt) > Date.parse(at)
      ? value
      : undefined;
  }
  async putRetrievalOutcome(input: {
    host: string;
    canonicalUrl: string;
    code: RetrievalDiagnosticCode;
    retryAt?: string;
    status: number;
    recordedAt: string;
    expiresAt: string;
  }) {
    await writeAtomicJson(
      join(
        this.root,
        "cache",
        "retrieval-outcomes",
        `${hash(input.canonicalUrl)}.json`,
      ),
      input,
    );
    if (input.retryAt) {
      const path = join(
        this.root,
        "cache",
        "retrieval-hosts",
        `${hash(input.host)}.json`,
      );
      const old = await optional(
        path,
        z.object({
          attemptCount: z.number().int().nonnegative(),
          windowStartedAt: z.string().datetime({ offset: true }),
          cooldownUntil: z.string().datetime({ offset: true }).optional(),
        }),
      );
      await writeAtomicJson(path, {
        attemptCount: old?.attemptCount ?? 1,
        windowStartedAt: old?.windowStartedAt ?? input.recordedAt,
        cooldownUntil:
          old?.cooldownUntil &&
          Date.parse(old.cooldownUntil) > Date.parse(input.retryAt)
            ? old.cooldownUntil
            : input.retryAt,
      });
    }
  }
  async clearRetrievalOutcome(host: string, canonicalUrl: string) {
    void host;
    await rm(
      join(
        this.root,
        "cache",
        "retrieval-outcomes",
        `${hash(canonicalUrl)}.json`,
      ),
      { force: true },
    );
  }
}
export class FileResearchPacketRepository implements ResearchPacketRepository {
  constructor(private root: string) {}
  async nextVersion(topicId: string) {
    const dir = join(this.root, "packets", safe(topicId));
    try {
      return (
        Math.max(
          0,
          ...(await readdir(dir)).map((x) =>
            Number(/^v(\d+)\.json$/.exec(x)?.[1] ?? 0),
          ),
        ) + 1
      );
    } catch (error) {
      if (missing(error)) return 1;
      throw error;
    }
  }
  async save(packet: ResearchPacket) {
    const value = researchPacketSchema.parse(packet);
    const dir = join(this.root, "packets", safe(value.topicId));
    if (!(await exclusive(join(dir, `v${value.version}.json`), value)))
      throw new Error("Packet version already exists");
    await writeAtomicJson(join(dir, "index.json"), {
      packetId: value.id,
      latestVersion: value.version,
      status: value.status,
      updatedAt: value.updatedAt,
    });
  }
  async get(topicId: string, version?: number) {
    if (!version)
      version = (
        await optional(
          join(this.root, "packets", safe(topicId), "index.json"),
          z.object({ latestVersion: z.number().int().positive() }),
        )
      )?.latestVersion;
    return version
      ? optional(
          join(this.root, "packets", safe(topicId), `v${version}.json`),
          researchPacketSchema,
        )
      : undefined;
  }
  async getByImportHash(topicId: string, importHash: string) {
    const next = await this.nextVersion(topicId);
    for (let version = 1; version < next; version += 1) {
      const packet = await this.get(topicId, version);
      if (packet?.provenance.importHash === importHash) return packet;
    }
    return undefined;
  }
}
export class FileResearchSourceExtensionRepository implements ResearchSourceExtensionRepository {
  private packets: FileResearchPacketRepository;
  private sources: FileResearchSourceRepository;
  constructor(private root: string) {
    this.packets = new FileResearchPacketRepository(root);
    this.sources = new FileResearchSourceRepository(root);
  }
  async persist(
    base: ResearchPacket,
    packet: ResearchPacket,
    source: ResearchSource,
    extractedText: string,
  ) {
    const latest = await this.packets.get(base.topicId);
    if (!latest || latest.version !== base.version)
      throw new Error("Research packet advanced during source extension");
    if (!packet.provenance.extensionHash)
      throw new Error("Source extension hash is required");
    const value = researchPacketSchema.parse({
      ...packet,
      version: await this.packets.nextVersion(base.topicId),
    });
    const sourceDir = join(
      this.root,
      "sources",
      safe(source.topicId),
      source.contentHash,
    );
    const sourceExisted = await access(join(sourceDir, "source.json")).then(
      () => true,
      () => false,
    );
    try {
      await this.sources.save(source, extractedText);
      await this.packets.save(value);
      return value;
    } catch (error) {
      if (!sourceExisted) await rm(sourceDir, { recursive: true, force: true });
      throw error;
    }
  }
}

export class FileHumanAssistedEvidenceRepository implements HumanAssistedEvidenceRepository {
  private packets: FileResearchPacketRepository;
  private sources: FileResearchSourceRepository;
  constructor(private root: string) {
    this.packets = new FileResearchPacketRepository(root);
    this.sources = new FileResearchSourceRepository(root);
  }
  async persist(
    base: ResearchPacket,
    packet: ResearchPacket,
    source: ResearchSource,
    evidence: HumanAssistedEvidenceRecord,
  ) {
    const evidencePath = join(
      this.root,
      "evidence",
      safe(evidence.topicId),
      `${safe(evidence.id)}.json`,
    );
    const existing = await optional(
      evidencePath,
      z.object({ packetVersion: z.number().int().positive() }),
    );
    if (existing)
      return (await this.packets.get(
        evidence.topicId,
        existing.packetVersion,
      ))!;
    const latest = await this.packets.get(base.topicId);
    if (!latest || latest.version !== base.version)
      throw new Error("Research packet advanced during evidence acceptance");
    const value = researchPacketSchema.parse({
      ...packet,
      version: await this.packets.nextVersion(base.topicId),
    });
    await this.sources.save(source, evidence.evidenceText);
    await this.packets.save(value);
    await writeAtomicJson(evidencePath, {
      ...evidence,
      packetVersion: value.version,
    });
    return value;
  }
}
export class FileAssistedResearchImportRepository implements AssistedResearchImportRepository {
  constructor(
    private packets: ResearchPacketRepository,
    private events: ApprovedEventRepository,
  ) {}
  async persist(packet: ResearchPacket, importedAt: string) {
    const importHash = packet.provenance.importHash;
    if (!importHash) throw new Error("Assisted packet requires an import hash");
    const existing = await this.packets.getByImportHash(
      packet.topicId,
      importHash,
    );
    if (existing) {
      if (!(await this.events.isConsumed(existing.approvedEventId)))
        await this.events.consume(
          existing.approvedEventId,
          existing.id,
          existing.version,
          importedAt,
        );
      return existing;
    }
    const value = researchPacketSchema.parse({
      ...packet,
      version: await this.packets.nextVersion(packet.topicId),
    });
    await this.packets.save(value);
    if (!(await this.events.isConsumed(value.approvedEventId)))
      await this.events.consume(
        value.approvedEventId,
        value.id,
        value.version,
        importedAt,
      );
    return value;
  }
}
export class FileResearchTaskRepository implements ResearchTaskRepository {
  constructor(private root: string) {}
  async write(
    topicId: string,
    packetVersion: number,
    files: Record<string, string>,
    input: unknown,
  ) {
    const dir = join(this.root, safe(topicId), `v${packetVersion}`);
    for (const [name, body] of Object.entries(files))
      await secureText(join(dir, name), body);
    await writeAtomicJson(join(dir, "research-input.json"), input);
    return dir;
  }
  async readInput(topicId: string, packetVersion: number) {
    return optional(
      join(
        this.root,
        safe(topicId),
        `v${packetVersion}`,
        "research-input.json",
      ),
      z.unknown(),
    );
  }
}
export class FileApprovedEventRepository implements ApprovedEventRepository {
  private telegram: FileTelegramRepository;
  constructor(
    private eventRoot: string,
    telegramRoot: string,
    private stateRoot: string,
  ) {
    this.telegram = new FileTelegramRepository(telegramRoot);
  }
  async next() {
    for (const event of await this.events())
      if (
        !(await this.isConsumed(event.id)) &&
        !(await this.isCancelled(event))
      )
        return event;
    return undefined;
  }
  async get(id: string) {
    return (await this.events()).find((event) => event.id === id);
  }
  queue(topicId: string) {
    return this.telegram.getQueueItem(topicId);
  }
  async isCancelled(event: TopicApprovedEvent) {
    const queue = await this.queue(event.topicId);
    return (
      event.status === "cancelled" ||
      !queue ||
      queue.approvalStatus !== "approved" ||
      !["ready_for_research", "awaiting_source"].includes(
        queue.researchReadiness,
      )
    );
  }
  async isConsumed(id: string) {
    return Boolean(
      await optional(
        join(this.stateRoot, "events", `${safe(id)}.json`),
        consumedSchema,
      ),
    );
  }
  async consume(
    id: string,
    packetId: string,
    packetVersion: number,
    at: string,
  ) {
    if (
      !(await exclusive(
        join(this.stateRoot, "events", `${safe(id)}.json`),
        consumedSchema.parse({
          eventId: id,
          packetId,
          packetVersion,
          consumedAt: at,
        }),
      ))
    )
      throw new Error("Event already consumed");
  }
  private async events() {
    try {
      return await Promise.all(
        (await readdir(this.eventRoot))
          .filter((x) => x.endsWith(".json"))
          .sort()
          .map(async (x) =>
            topicApprovedEventSchema.parse(
              JSON.parse(await readFile(join(this.eventRoot, x), "utf8")),
            ),
          ),
      );
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
}
export function stable(prefix: string, value: string) {
  return `${prefix}_${hash(value).slice(0, 24)}`;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function safe(value: string) {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(value))
    throw new Error("Unsafe identifier");
  return value;
}
async function optional<T>(
  path: string,
  schema: ZodType<T>,
): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function exclusive(path: string, value: unknown) {
  let handle;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    )
      return false;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function secureText(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
}
function missing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
