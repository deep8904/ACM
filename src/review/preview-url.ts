import { createHmac, timingSafeEqual } from "node:crypto";

import type { DraftPreview } from "./models";

export function createRemotePreviewUrl(
  preview: DraftPreview,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const origin = environment.CONTROL_PLANE_ORIGIN;
  const secret =
    environment.PREVIEW_SIGNING_SECRET ?? environment.TELEGRAM_CALLBACK_SECRET;
  if (!origin || !secret) return preview.path;
  const expires = String(Math.floor(Date.parse(preview.expiresAt) / 1000));
  const signature = sign(preview.id, expires, secret);
  const url = new URL(`/api/preview/${encodeURIComponent(preview.id)}`, origin);
  url.searchParams.set("expires", expires);
  url.searchParams.set("signature", signature);
  return url.toString();
}

export function verifyRemotePreviewToken(
  id: string,
  expires: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  if (!/^preview_[a-f0-9]{24}$/.test(id) || !/^\d{10,}$/.test(expires))
    return false;
  const expiryMs = Number(expires) * 1000;
  if (
    !Number.isSafeInteger(expiryMs) ||
    expiryMs <= now ||
    expiryMs > now + 24 * 60 * 60 * 1000
  )
    return false;
  const expected = sign(id, expires, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(id: string, expires: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${id}:${expires}`)
    .digest("base64url");
}
