import { buildTelegramWebhookHandler } from "../../../../telegram/runtime";
import { redactDatabaseSecrets } from "../../../../database/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    return await buildTelegramWebhookHandler()(request);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "telegram_webhook_unavailable",
        error: safeError(error),
      }),
    );
    return Response.json(
      { ok: false, error: "telegram_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return redactDatabaseSecrets(message)
    .replace(/(key|token|secret)=[^\s&]+/gi, "$1=<redacted>")
    .replace(/bot\d{6,}:[A-Za-z0-9_-]+/g, "<redacted bot token>")
    .slice(0, 1000);
}

export function GET(): Response {
  return Response.json(
    { ok: false, error: "method_not_allowed" },
    { status: 405 },
  );
}
