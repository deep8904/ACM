import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { TelegramControlError } from "./errors";

export const callbackActionSchema = z.enum(["a", "r", "s", "g", "n", "c"]);
export type CallbackAction = z.infer<typeof callbackActionSchema>;

export interface ParsedCallback {
  action: CallbackAction;
  shortId: string;
  version: number;
}

export function createCallbackData(
  action: CallbackAction,
  shortId: string,
  version: number,
  secret: string,
): string {
  const payload = `t:${action}:${shortId}:${version}`;
  const signature = sign(payload, secret);
  const value = `${payload}:${signature}`;
  if (Buffer.byteLength(value, "utf8") > 64)
    throw new Error("Callback data exceeds Telegram's 64-byte limit");
  return value;
}

export function parseCallbackData(
  value: string,
  secret: string,
): ParsedCallback {
  const match = /^t:([arsgnc]):([a-f0-9]{12}):(\d+):([A-Za-z0-9_-]{10})$/.exec(
    value,
  );
  if (!match)
    throw new TelegramControlError(
      "stale_callback",
      "Invalid or outdated action",
      400,
    );
  const [, rawAction, shortId, rawVersion, provided] = match;
  const payload = `t:${rawAction}:${shortId}:${rawVersion}`;
  const expected = sign(payload, secret);
  if (!safeEqual(expected, provided ?? "")) {
    throw new TelegramControlError(
      "stale_callback",
      "Invalid or outdated action",
      400,
    );
  }
  return {
    action: callbackActionSchema.parse(rawAction),
    shortId: shortId as string,
    version: Number(rawVersion),
  };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url")
    .slice(0, 10);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
