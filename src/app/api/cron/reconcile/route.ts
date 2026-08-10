import { timingSafeEqual } from "node:crypto";

import { createRepositoryComposition } from "../../../../storage/composition";
import { reconcileAutomationQueue } from "../../../../orchestration/reconcile";
import { PostgresAutomationJobRepository } from "../../../../orchestration/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET ?? "";
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !same(expected, supplied))
    return Response.json({ ok: false }, { status: 401 });
  const composition = createRepositoryComposition(process.env);
  try {
    await composition.verify();
    if (!composition.sql) throw new Error("Durable storage is required");
    const jobs = new PostgresAutomationJobRepository(composition.sql);
    const result = await reconcileAutomationQueue(composition.sql, jobs);
    await jobs.heartbeatComponent({
      component: "scheduler",
      instanceId: process.env.VERCEL_REGION ?? "vercel-cron",
      status: "healthy",
      details: { reconciled: result.enqueued.length },
      observedAt: new Date().toISOString(),
    });
    return Response.json({ ok: true, queued: result.enqueued.length });
  } finally {
    await composition.close();
  }
}

function same(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
