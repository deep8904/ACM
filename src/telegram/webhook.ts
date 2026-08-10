import { timingSafeEqual } from "node:crypto";

import { telegramUpdateSchema } from "./models";
import type { TopicApprovalService } from "./service";

export const telegramWebhookBodyLimit = 64 * 1024;

export interface WebhookHandlerOptions {
  secrets: readonly string[];
  service: Pick<TopicApprovalService, "processUpdate">;
  bodyLimit?: number;
}

export function createTelegramWebhookHandler(options: WebhookHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    const provided =
      request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (
      options.secrets.length === 0 ||
      !options.secrets.some((secret) => safeEqual(secret, provided))
    ) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const contentType =
      request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json"))
      return json({ ok: false, error: "content_type_required" }, 415);
    const limit = options.bodyLimit ?? telegramWebhookBodyLimit;
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > limit)
      return json({ ok: false, error: "body_too_large" }, 413);
    let body: string;
    try {
      body = await readBodyLimited(request, limit);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return json({ ok: false, error: "body_too_large" }, 413);
      }
      return json({ ok: false, error: "invalid_body" }, 400);
    }
    let document: unknown;
    try {
      document = JSON.parse(body) as unknown;
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    const parsed = telegramUpdateSchema.safeParse(document);
    if (!parsed.success)
      return json({ ok: false, error: "invalid_update" }, 400);
    try {
      const result = await options.service.processUpdate(parsed.data);
      return json({ ok: true, status: result.status }, 200);
    } catch {
      return json({ ok: false, error: "internal_error" }, 500);
    }
  };
}

class BodyTooLargeError extends Error {}

async function readBodyLimited(
  request: Request,
  limit: number,
): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
