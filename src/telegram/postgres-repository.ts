import type { DatabaseClient, DatabaseTransaction } from "../database/client";
import { withTransaction } from "../database/client";
import { TelegramControlError } from "./errors";
import type { TopicApprovalRepository } from "./interfaces";
import type { RankingRunOrigin } from "./interfaces";
import {
  conversationStateSchema,
  messageIndexSchema,
  processedUpdateSchema,
  topicApprovalSchema,
  topicApprovedEventSchema,
  topicQueueItemSchema,
  type ConversationState,
  type MessageIndex,
  type ProcessedUpdate,
  type TopicApproval,
  type TopicApprovedEvent,
  type TopicQueueItem,
} from "./models";

type Queryable = DatabaseClient | DatabaseTransaction;
type PayloadRow = { payload: unknown };

function one<T>(
  rows: PayloadRow[],
  parse: (value: unknown) => T,
): T | undefined {
  return rows[0] ? parse(rows[0].payload) : undefined;
}

function conflict(): never {
  throw new TelegramControlError(
    "queue_conflict",
    "Topic state changed; refresh the topic list",
    409,
  );
}

export class PostgresTopicApprovalRepository implements TopicApprovalRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async getById(id: string) {
    return one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.topic_approvals where id = ${id}`,
      topicApprovalSchema.parse,
    );
  }
  async getByTopicId(topicId: string) {
    return one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.topic_approvals where topic_id = ${topicId} order by version desc limit 1`,
      topicApprovalSchema.parse,
    );
  }
  async saveApproval(approval: TopicApproval, expectedVersion?: number) {
    const value = topicApprovalSchema.parse(approval);
    await withTransaction(this.sql, async (tx) =>
      this.writeApproval(tx, value, expectedVersion),
    );
    return value;
  }
  async getQueueItem(topicId: string) {
    return one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.topic_queue_items where topic_id = ${topicId}`,
      topicQueueItemSchema.parse,
    );
  }
  async getQueueItemByShortId(shortId: string) {
    return one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.topic_queue_items where short_id = ${shortId}`,
      topicQueueItemSchema.parse,
    );
  }
  async saveQueueItem(item: TopicQueueItem, expectedVersion?: number) {
    const value = topicQueueItemSchema.parse(item);
    await withTransaction(this.sql, async (tx) =>
      this.writeQueue(tx, value, expectedVersion),
    );
    return value;
  }
  async listQueue() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.topic_queue_items order by created_at, id`;
    return rows.map((row) => topicQueueItemSchema.parse(row.payload));
  }
  async activateRankedRun(
    runId: string,
    origin: RankingRunOrigin,
    eligibleCount: number,
    items: readonly TopicQueueItem[],
  ) {
    return withTransaction(this.sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(4247182937)`;
      const report = await tx<{ ranked_at: Date | string }[]>`
        select coalesce((payload->>'createdAt')::timestamptz,created_at) as ranked_at
        from content_machine.workflow_artifacts
        where run_id=${runId} and stage='ranking' and name='ranking-report.json'
      `;
      if (!report[0]) throw new Error(`Ranking report is missing for ${runId}`);

      const existing = await tx<
        { status: "actionable" | "empty" | "superseded" }[]
      >`
        select status from content_machine.ranking_sets where run_id=${runId}
      `;
      if (existing[0])
        return {
          status: existing[0].status,
          items:
            existing[0].status === "actionable"
              ? await this.queueForRun(tx, runId)
              : [],
        };

      const rankedAt = new Date(report[0].ranked_at).toISOString();
      const current = await tx<{ run_id: string; ranked_at: Date | string }[]>`
        select run_id,ranked_at from content_machine.ranking_sets
        where status='actionable' for update
      `;
      if (eligibleCount === 0 || items.length === 0) {
        await tx`
          insert into content_machine.ranking_sets
            (run_id,origin,status,eligible_count,display_count,ranked_at)
          values (${runId},${origin},'empty',${eligibleCount},${items.length},${rankedAt})
        `;
        return { status: "empty" as const, items: [] };
      }
      const active = current[0];
      if (
        active &&
        (new Date(active.ranked_at).getTime() > new Date(rankedAt).getTime() ||
          (new Date(active.ranked_at).getTime() ===
            new Date(rankedAt).getTime() &&
            active.run_id.localeCompare(runId) > 0))
      ) {
        await tx`
          insert into content_machine.ranking_sets
            (run_id,origin,status,eligible_count,display_count,ranked_at,superseded_by,superseded_at)
          values (${runId},${origin},'superseded',${eligibleCount},${items.length},${rankedAt},${active.run_id},now())
        `;
        return { status: "superseded" as const, items: [] };
      }

      for (const item of items) await this.writeQueue(tx, item);
      if (active) {
        await tx`
          update content_machine.ranking_sets
          set status='superseded',superseded_by=${runId},superseded_at=now(),updated_at=now()
          where run_id=${active.run_id} and status='actionable'
        `;
      }
      const currentTopicIds = items.map(({ topicId }) => topicId);
      await tx`
        update content_machine.topic_queue_items
        set approval_status='superseded',version=version+1,updated_at=now(),
          payload=jsonb_set(
            jsonb_set(
              jsonb_set(payload,'{approvalStatus}','"superseded"'::jsonb),
              '{version}',to_jsonb(version+1)
            ),
            '{updatedAt}',to_jsonb(now()::text)
          )
        where approval_status='pending' and payload->>'origin'='ranked'
          and topic_id not in ${tx(currentTopicIds)}
      `;
      await tx`
        insert into content_machine.ranking_sets
          (run_id,origin,status,eligible_count,display_count,ranked_at,activated_at)
        values (${runId},${origin},'actionable',${eligibleCount},${items.length},${rankedAt},now())
      `;
      return {
        status: "actionable" as const,
        items: await this.queueForRun(tx, runId),
      };
    });
  }
  async getConversation(chatId: string, userId: string) {
    return one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.telegram_conversations where chat_id = ${chatId} and user_id = ${userId} and expires_at > now()`,
      conversationStateSchema.parse,
    );
  }
  async saveConversation(state: ConversationState) {
    const value = conversationStateSchema.parse(state);
    await this.sql`
      insert into content_machine.telegram_conversations
        (chat_id,user_id,state,topic_id,version,expires_at,payload,created_at,updated_at)
      values (${value.chatId},${value.userId},${value.state},${value.topicId ?? null},${value.version},${value.expiresAt},${this.sql.json(value)},${value.createdAt},now())
      on conflict (chat_id,user_id) do update set state=excluded.state,topic_id=excluded.topic_id,
        version=excluded.version,expires_at=excluded.expires_at,payload=excluded.payload,updated_at=now()
    `;
  }
  async clearConversation(chatId: string, userId: string) {
    await this
      .sql`delete from content_machine.telegram_conversations where chat_id=${chatId} and user_id=${userId}`;
  }
  async getMessageIndex(shortId: string) {
    return one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.telegram_message_index where short_id=${shortId}`,
      messageIndexSchema.parse,
    );
  }
  async saveMessageIndex(index: MessageIndex) {
    const value = messageIndexSchema.parse(index);
    await this.sql`
      insert into content_machine.telegram_message_index
        (short_id,topic_id,chat_id,telegram_message_id,version,payload,updated_at)
      values (${value.shortId},${value.topicId},${value.chatId},${value.telegramMessageId},${value.version},${this.sql.json(value)},${value.updatedAt})
      on conflict (short_id) do update set topic_id=excluded.topic_id,chat_id=excluded.chat_id,
        telegram_message_id=excluded.telegram_message_id,version=excluded.version,payload=excluded.payload,updated_at=excluded.updated_at
    `;
  }
  async claimUpdate(
    updateId: number,
    callbackQueryId: string | undefined,
    now: string,
  ) {
    return withTransaction(this.sql, async (tx) => {
      const rows = await tx<{ update_id: string }[]>`
        insert into content_machine.telegram_updates
          (update_id,callback_query_id,status,command_type,claimed_at,payload)
        values (${updateId},${callbackQueryId ?? null},'processing','pending',${now},null)
        on conflict do nothing returning update_id
      `;
      if (!rows[0]) return false;
      if (callbackQueryId) {
        const callbacks = await tx<{ callback_query_id: string }[]>`
          insert into content_machine.telegram_callbacks (callback_query_id,update_id)
          values (${callbackQueryId},${updateId}) on conflict do nothing returning callback_query_id
        `;
        if (!callbacks[0]) {
          await tx`delete from content_machine.telegram_updates where update_id=${updateId}`;
          return false;
        }
      }
      return true;
    });
  }
  async completeUpdate(record: ProcessedUpdate) {
    const value = processedUpdateSchema.parse({
      ...record,
      status: "completed",
    });
    await this.sql`
      update content_machine.telegram_updates set status='completed',command_type=${value.commandType},
        processed_at=${value.processedAt},payload=${this.sql.json(value)} where update_id=${value.updateId}
    `;
  }
  async releaseUpdate(updateId: number, callbackQueryId?: string) {
    await withTransaction(this.sql, async (tx) => {
      if (callbackQueryId)
        await tx`delete from content_machine.telegram_callbacks where callback_query_id=${callbackQueryId}`;
      await tx`delete from content_machine.telegram_updates where update_id=${updateId} and status='processing'`;
    });
  }
  async hasProcessedUpdate(updateId: number) {
    const rows = await this.sql<
      { found: boolean }[]
    >`select exists(select 1 from content_machine.telegram_updates where update_id=${updateId}) as found`;
    return Boolean(rows[0]?.found);
  }
  async saveApprovedEvent(event: TopicApprovedEvent) {
    const value = topicApprovedEventSchema.parse(event);
    const rows = await this.sql<{ id: string }[]>`
      insert into content_machine.topic_approved_events (id,topic_id,status,version,payload,approved_at)
      values (${value.id},${value.topicId},${value.status},${value.version},${this.sql.json(value)},${value.approvedAt})
      on conflict do nothing returning id
    `;
    if (rows[0])
      await this
        .sql`insert into content_machine.topic_event_state(event_id) values (${value.id}) on conflict do nothing`;
    return Boolean(rows[0]);
  }
  async getApprovedEventByTopicId(topicId: string) {
    return one(
      await this.sql<
        PayloadRow[]
      >`select payload from content_machine.topic_approved_events where topic_id=${topicId}`,
      topicApprovedEventSchema.parse,
    );
  }
  async updateApprovedEvent(
    event: TopicApprovedEvent,
    expectedVersion: number,
  ) {
    const value = topicApprovedEventSchema.parse(event);
    const rows = await this.sql<{ id: string }[]>`
      update content_machine.topic_approved_events set status=${value.status},version=${value.version},payload=${this.sql.json(value)}
      where id=${value.id} and version=${expectedVersion} returning id
    `;
    if (!rows[0]) conflict();
  }
  async listApprovedEvents() {
    const rows = await this.sql<
      PayloadRow[]
    >`select payload from content_machine.topic_approved_events order by approved_at,id`;
    return rows.map((row) => topicApprovedEventSchema.parse(row.payload));
  }
  async saveDecision(
    item: TopicQueueItem,
    approval: TopicApproval,
    event: TopicApprovedEvent | undefined,
    expectedQueueVersion: number,
    expectedApprovalVersion?: number,
  ) {
    const queue = topicQueueItemSchema.parse(item);
    const decision = topicApprovalSchema.parse(approval);
    const outbox = event ? topicApprovedEventSchema.parse(event) : undefined;
    await withTransaction(this.sql, async (tx) => {
      await this.writeQueue(tx, queue, expectedQueueVersion);
      await this.writeApproval(tx, decision, expectedApprovalVersion);
      if (outbox) {
        const inserted = await tx<{ id: string }[]>`
          insert into content_machine.topic_approved_events (id,topic_id,approval_id,status,version,payload,approved_at)
          values (${outbox.id},${outbox.topicId},${decision.id},${outbox.status},${outbox.version},${tx.json(outbox)},${outbox.approvedAt})
          on conflict (topic_id) do nothing returning id
        `;
        if (inserted[0])
          await tx`insert into content_machine.topic_event_state(event_id) values (${outbox.id})`;
      }
    });
  }
  private async writeQueue(
    sql: Queryable,
    value: TopicQueueItem,
    expected?: number,
  ) {
    if (expected === undefined) {
      await sql`
        insert into content_machine.topic_queue_items
          (id,short_id,topic_id,candidate_id,run_id,approval_status,trigger_state,version,expires_at,payload,created_at,updated_at)
        values (${value.id},${value.shortId},${value.topicId},${value.candidateId},${value.runId},${value.approvalStatus},${value.triggerState},${value.version},${value.expiresAt ?? null},${sql.json(value)},${value.createdAt},${value.updatedAt})
        on conflict (topic_id) do update set short_id=excluded.short_id,approval_status=excluded.approval_status,
          trigger_state=excluded.trigger_state,version=excluded.version,expires_at=excluded.expires_at,payload=excluded.payload,updated_at=excluded.updated_at
      `;
      return;
    }
    const rows = await sql<{ id: string }[]>`
      update content_machine.topic_queue_items set approval_status=${value.approvalStatus},trigger_state=${value.triggerState},
        version=${value.version},expires_at=${value.expiresAt ?? null},payload=${sql.json(value)},updated_at=${value.updatedAt}
      where topic_id=${value.topicId} and version=${expected} returning id
    `;
    if (!rows[0]) conflict();
  }
  private async writeApproval(
    sql: Queryable,
    value: TopicApproval,
    expected?: number,
  ) {
    if (expected === undefined) {
      const rows = await sql<{ id: string }[]>`
        insert into content_machine.topic_approvals
          (id,topic_id,action,status,telegram_update_id,callback_query_id,version,payload,created_at,updated_at)
        values (${value.id},${value.topicId},${value.action},${value.status},${value.telegramUpdateId},${value.callbackQueryId ?? null},${value.version},${sql.json(value)},${value.createdAt},${value.updatedAt})
        on conflict (id) do nothing returning id
      `;
      if (!rows[0]) conflict();
      return;
    }
    const rows = await sql<{ id: string }[]>`
      update content_machine.topic_approvals set action=${value.action},status=${value.status},telegram_update_id=${value.telegramUpdateId},
        callback_query_id=${value.callbackQueryId ?? null},version=${value.version},payload=${sql.json(value)},updated_at=${value.updatedAt}
      where id=${value.id} and version=${expected} returning id
    `;
    if (!rows[0]) conflict();
  }
  private async queueForRun(sql: Queryable, runId: string) {
    const rows = await sql<PayloadRow[]>`
      select payload from content_machine.topic_queue_items
      where run_id=${runId} order by created_at,id
    `;
    return rows.map((row) => topicQueueItemSchema.parse(row.payload));
  }
}
