import type { DatabaseClient } from "../database/client";
import { historyEntrySchema, type HistoryEntry } from "./models";
import type { HistoryRepository } from "./history";

export class PostgresHistoryRepository implements HistoryRepository {
  constructor(private sql: DatabaseClient) {}
  async list(): Promise<HistoryEntry[]> {
    const rows = await this.sql<
      { payload: unknown }[]
    >`select payload from content_machine.ranking_history order by created_at,id`;
    return rows.map((row) => historyEntrySchema.parse(row.payload));
  }
}
