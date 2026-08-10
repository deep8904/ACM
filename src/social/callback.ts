import { createHmac, timingSafeEqual } from "node:crypto";
export type SocialCallbackAction =
  "a" | "c" | "h" | "r" | "t" | "p" | "v" | "q" | "n" | "b";
function sign(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url")
    .slice(0, 10);
}
export function createSocialCallback(
  action: SocialCallbackAction,
  itemShortId: string,
  version: number,
  secret: string,
) {
  if (
    !/^[a-f0-9]{12}$/.test(itemShortId) ||
    !Number.isInteger(version) ||
    version < 1
  )
    throw new Error("Invalid social callback input");
  const payload = `s:${action}:${itemShortId}:${version}`;
  return `${payload}:${sign(payload, secret)}`;
}
export function parseSocialCallback(value: string, secret: string) {
  const match =
    /^s:([achrtpvqnb]):([a-f0-9]{12}):(\d+):([A-Za-z0-9_-]{10})$/.exec(value);
  if (!match) throw new Error("Invalid social callback");
  const action = match[1] as SocialCallbackAction,
    itemShortId = match[2]!,
    version = Number(match[3]),
    payload = `s:${action}:${itemShortId}:${version}`,
    actual = Buffer.from(match[4]!),
    expected = Buffer.from(sign(payload, secret));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid social callback signature");
  return { action, itemShortId, version };
}
