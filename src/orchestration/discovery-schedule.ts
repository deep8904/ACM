import type { DatabaseClient } from "../database/client";

export const DISCOVERY_WEEKDAYS_UTC = [1, 4] as const;
export const DISCOVERY_HOUR_UTC = 16;

export interface DiscoveryScheduleStatus {
  lastSuccessfulAt?: string;
  lastWindowStart?: string;
  lastWindowEnd?: string;
  currentWindowStart: string;
  currentWindowEnd: string;
  nextDiscoveryAt: string;
}

export function currentDiscoverySlot(now: Date): Date {
  const cursor = new Date(now);
  cursor.setUTCMinutes(0, 0, 0);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(cursor);
    candidate.setUTCDate(cursor.getUTCDate() - offset);
    candidate.setUTCHours(DISCOVERY_HOUR_UTC, 0, 0, 0);
    if (
      DISCOVERY_WEEKDAYS_UTC.includes(
        candidate.getUTCDay() as (typeof DISCOVERY_WEEKDAYS_UTC)[number],
      ) &&
      candidate.getTime() <= now.getTime()
    )
      return candidate;
  }
  throw new Error("Could not resolve the current discovery slot");
}

export function nextDiscoverySlot(now: Date): Date {
  const cursor = new Date(now);
  cursor.setUTCHours(DISCOVERY_HOUR_UTC, 0, 0, 0);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(cursor);
    candidate.setUTCDate(cursor.getUTCDate() + offset);
    if (
      DISCOVERY_WEEKDAYS_UTC.includes(
        candidate.getUTCDay() as (typeof DISCOVERY_WEEKDAYS_UTC)[number],
      ) &&
      candidate.getTime() > now.getTime()
    )
      return candidate;
  }
  throw new Error("Could not resolve the next discovery slot");
}

export async function discoveryScheduleStatus(
  sql: DatabaseClient,
  now = new Date(),
): Promise<DiscoveryScheduleStatus> {
  const rows = await sql<
    {
      last_successful_at: Date | string | null;
      last_window_start: Date | string | null;
      last_window_end: Date | string | null;
    }[]
  >`
    select last_successful_at,last_window_start,last_window_end
    from content_machine.discovery_schedule_state where id='primary'
  `;
  const row = rows[0];
  const currentEnd = currentDiscoverySlot(now);
  const bootstrapStart = new Date(currentEnd.getTime() - 7 * 24 * 60 * 60_000);
  const lastSuccessfulAt = row?.last_successful_at
    ? new Date(row.last_successful_at).toISOString()
    : undefined;
  const lastWindowEnd = row?.last_window_end
    ? new Date(row.last_window_end).toISOString()
    : undefined;
  return {
    lastSuccessfulAt,
    lastWindowStart: row?.last_window_start
      ? new Date(row.last_window_start).toISOString()
      : undefined,
    lastWindowEnd,
    currentWindowStart: lastWindowEnd ?? bootstrapStart.toISOString(),
    currentWindowEnd: currentEnd.toISOString(),
    nextDiscoveryAt: nextDiscoverySlot(now).toISOString(),
  };
}
