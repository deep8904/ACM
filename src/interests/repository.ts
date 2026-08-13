import { createHash } from "node:crypto";

import { type DatabaseClient, withTransaction } from "../database/client";
import { toJsonValue } from "../database/json";
import { editorialInterestSchema, type EditorialInterest } from "./models";

export interface InterestActor {
  chatId?: string;
  userId?: string;
  updateId?: number;
}

export class PostgresEditorialInterestRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async list(includeRemoved = false): Promise<EditorialInterest[]> {
    const rows = includeRemoved
      ? await this.sql<{ payload: unknown }[]>`
          select payload from content_machine.editorial_interests order by is_default desc,created_at,id
        `
      : await this.sql<{ payload: unknown }[]>`
          select payload from content_machine.editorial_interests
          where status<>'removed' order by is_default desc,created_at,id
        `;
    return rows.map((row) => editorialInterestSchema.parse(row.payload));
  }

  async get(reference: string): Promise<EditorialInterest | undefined> {
    const rows = await this.sql<{ payload: unknown }[]>`
      select payload from content_machine.editorial_interests
      where id=${reference} or short_id=${reference} limit 1
    `;
    return rows[0] ? editorialInterestSchema.parse(rows[0].payload) : undefined;
  }

  async add(name: string, keywords: string[], actor: InterestActor) {
    const normalizedName = normalize(name);
    const cleanKeywords = [...new Set(keywords.map(normalize).filter(Boolean))];
    if (normalizedName.length < 3 || cleanKeywords.length === 0)
      throw new Error("Interest name and at least one keyword are required");
    const digest = hash(normalizedName);
    const now = new Date().toISOString();
    const value = editorialInterestSchema.parse({
      id: `interest_${digest.slice(0, 24)}`,
      shortId: digest.slice(0, 12),
      name: name.trim(),
      keywords: cleanKeywords,
      status: "enabled",
      isDefault: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return withTransaction(this.sql, async (tx) => {
      const existing = await tx<{ payload: unknown }[]>`
        select payload from content_machine.editorial_interests
        where normalized_name=${normalizedName} for update
      `;
      const old = existing[0]
        ? editorialInterestSchema.parse(existing[0].payload)
        : undefined;
      const next = old
        ? editorialInterestSchema.parse({
            ...old,
            name: value.name,
            keywords: value.keywords,
            status: "enabled",
            version: old.version + 1,
            updatedAt: now,
          })
        : value;
      await tx`
        insert into content_machine.editorial_interests
          (id,short_id,name,normalized_name,keywords,status,is_default,version,created_at,updated_at,payload)
        values (${next.id},${next.shortId},${next.name},${normalizedName},${tx.json(next.keywords)},${next.status},${next.isDefault},${next.version},${next.createdAt},${next.updatedAt},${tx.json(toJsonValue(next))})
        on conflict(normalized_name) do update set name=excluded.name,keywords=excluded.keywords,
          status=excluded.status,version=excluded.version,updated_at=excluded.updated_at,payload=excluded.payload
      `;
      await audit(tx, next, old ? "enabled" : "added", actor);
      return next;
    });
  }

  async setStatus(
    reference: string,
    status: "enabled" | "disabled" | "removed",
    actor: InterestActor,
    expectedVersion?: number,
  ) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<{ payload: unknown }[]>`
        select payload from content_machine.editorial_interests
        where id=${reference} or short_id=${reference} for update
      `;
      if (!rows[0]) throw new Error("Interest was not found");
      const old = editorialInterestSchema.parse(rows[0].payload);
      if (expectedVersion !== undefined && old.version !== expectedVersion)
        throw new Error("Interest state changed; run /interests again");
      if (old.status === status) return old;
      const next = editorialInterestSchema.parse({
        ...old,
        status,
        version: old.version + 1,
        updatedAt: new Date().toISOString(),
      });
      await tx`
        update content_machine.editorial_interests
        set status=${status},version=${next.version},updated_at=${next.updatedAt},payload=${tx.json(toJsonValue(next))}
        where id=${old.id}
      `;
      await audit(tx, next, status, actor);
      return next;
    });
  }
}

async function audit(
  tx: Parameters<Parameters<typeof withTransaction>[1]>[0],
  interest: EditorialInterest,
  action: "added" | "enabled" | "disabled" | "removed",
  actor: InterestActor,
) {
  await tx`
    insert into content_machine.editorial_interest_events
      (interest_id,action,actor_chat_id,actor_user_id,telegram_update_id,payload)
    values (${interest.id},${action},${actor.chatId ?? null},${actor.userId ?? null},${actor.updateId ?? null},
      ${tx.json(toJsonValue({ interestId: interest.id, version: interest.version, status: interest.status }))})
    on conflict do nothing
  `;
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
