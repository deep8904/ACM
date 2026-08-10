import { buildTelegramWebhookHandler } from "../../../../telegram/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    return await buildTelegramWebhookHandler()(request);
  } catch {
    return Response.json(
      { ok: false, error: "telegram_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export function GET(): Response {
  return Response.json(
    { ok: false, error: "method_not_allowed" },
    { status: 405 },
  );
}
