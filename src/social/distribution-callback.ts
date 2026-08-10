import { createHmac, timingSafeEqual } from "node:crypto";
import type { SocialPlatform } from "./models";

export type DistributionCallbackAction =
  SocialPlatform | "prepare" | "confirm" | "review" | "cancel" | "skip";
const code: Record<DistributionCallbackAction, string> = {
  linkedin: "l",
  x: "x",
  instagram: "i",
  medium: "m",
  prepare: "p",
  confirm: "a",
  review: "r",
  cancel: "c",
  skip: "s",
};
const action = Object.fromEntries(
  Object.entries(code).map(([name, value]) => [value, name]),
) as Record<string, DistributionCallbackAction>;

export function createDistributionCallback(
  value: DistributionCallbackAction,
  planShortId: string,
  revision: number,
  secret: string,
) {
  if (
    !/^[a-f0-9]{12}$/.test(planShortId) ||
    !Number.isInteger(revision) ||
    revision < 0
  )
    throw new Error("Invalid distribution callback input");
  const payload = `d:${code[value]}:${planShortId}:${revision}`;
  return `${payload}:${sign(payload, secret)}`;
}

export function parseDistributionCallback(value: string, secret: string) {
  const match =
    /^d:([lximparcs]):([a-f0-9]{12}):(\d+):([A-Za-z0-9_-]{10})$/.exec(value);
  if (!match) throw new Error("Invalid distribution callback");
  const payload = `d:${match[1]}:${match[2]}:${match[3]}`;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(match[4]!);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid distribution callback signature");
  return {
    action: action[match[1]!]!,
    planShortId: match[2]!,
    revision: Number(match[3]),
  };
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url")
    .slice(0, 10);
}
