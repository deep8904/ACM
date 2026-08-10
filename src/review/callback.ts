import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const finalCallbackActionSchema = z.enum([
  "p",
  "s",
  "c",
  "h",
  "r",
  "x",
  "i",
  "q",
  "v",
  "t",
  "u",
]);
export type FinalCallbackAction = z.infer<typeof finalCallbackActionSchema>;

export function createFinalCallbackData(
  action: FinalCallbackAction,
  shortId: string,
  version: number,
  secret: string,
) {
  const payload = `a:${action}:${shortId}:${version}`;
  const value = `${payload}:${signature(payload, secret)}`;
  if (Buffer.byteLength(value) > 64)
    throw new Error("Final callback exceeds 64 bytes");
  return value;
}

export function parseFinalCallbackData(value: string, secret: string) {
  const match =
    /^a:([pschrxiqvtu]):([a-f0-9]{12}):(\d+):([A-Za-z0-9_-]{10})$/.exec(value);
  if (!match) throw new Error("Invalid or outdated final article action");
  const [, action, shortId, rawVersion, provided] = match;
  const payload = `a:${action}:${shortId}:${rawVersion}`;
  const expected = signature(payload, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(provided ?? "");
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new Error("Invalid or outdated final article action");
  return {
    action: finalCallbackActionSchema.parse(action),
    shortId: shortId as string,
    version: Number(rawVersion),
  };
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url")
    .slice(0, 10);
}
