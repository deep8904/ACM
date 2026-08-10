import { createRepositoryComposition } from "../../../../storage/composition";
import { verifyRemotePreviewToken } from "../../../../review/preview-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const expires = url.searchParams.get("expires") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  const secret =
    process.env.PREVIEW_SIGNING_SECRET ??
    process.env.TELEGRAM_CALLBACK_SECRET ??
    "";
  if (!secret || !verifyRemotePreviewToken(id, expires, signature, secret))
    return new Response("Preview link is invalid or expired.", { status: 403 });
  const composition = createRepositoryComposition(process.env);
  try {
    await composition.verify();
    if (!composition.sql)
      return new Response("Preview storage is unavailable.", { status: 503 });
    const rows = await composition.sql<
      {
        html: string;
        superseded_at: Date | string | null;
        payload: { expiresAt?: string; status?: string };
      }[]
    >`
      select html,superseded_at,payload from content_machine.draft_previews where id=${id}
    `;
    const preview = rows[0];
    if (
      !preview ||
      preview.superseded_at ||
      preview.payload.status !== "active" ||
      !preview.payload.expiresAt ||
      Date.parse(preview.payload.expiresAt) <= Date.now()
    )
      return new Response("Preview is no longer available.", { status: 410 });
    return new Response(preview.html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store, max-age=0",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-robots-tag": "noindex, nofollow, noarchive",
        "x-content-type-options": "nosniff",
      },
    });
  } finally {
    await composition.close();
  }
}
