import { timingSafeEqual } from "node:crypto";

import { createRepositoryComposition } from "../../../../storage/composition";
import { reconcileAutomationQueue } from "../../../../orchestration/reconcile";

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
    const result = await reconcileAutomationQueue(composition.sql);
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
