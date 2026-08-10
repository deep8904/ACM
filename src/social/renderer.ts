import sharp from "sharp";
import { createHash } from "node:crypto";
import { sha256 } from "../writing/task";
import {
  socialAssetSchema,
  type SocialAsset,
  type SocialPlatform,
} from "./models";

const colors = {
  ink: "#0B0D10",
  surface: "#14181D",
  paper: "#F5F7F9",
  white: "#FFFFFF",
  muted: "#AAB3BE",
  accent: "#4C7DFF",
};

export interface RenderRequest {
  planId: string;
  publicationId: string;
  packageId: string;
  packageVersion: number;
  platform: SocialPlatform;
  kind: SocialAsset["kind"];
  width: number;
  height: number;
  title: string;
  eyebrow: string;
  body?: string;
  footer?: string;
  altText: string;
  slideNumber?: number;
  createdAt: string;
}

export async function renderSocialAsset(request: RenderRequest) {
  const svg = socialSvg(request);
  const bytes = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  const fingerprint = sha256(
    JSON.stringify({
      planId: request.planId,
      platform: request.platform,
      kind: request.kind,
      slideNumber: request.slideNumber,
      width: request.width,
      height: request.height,
      title: request.title,
      eyebrow: request.eyebrow,
      body: request.body,
      footer: request.footer,
    }),
  );
  const filename = `${request.platform}-${request.kind}${request.slideNumber ? `-${request.slideNumber}` : ""}-${fingerprint.slice(0, 10)}.png`;
  const asset = socialAssetSchema.parse({
    id: `socialasset_${fingerprint.slice(0, 24)}`,
    planId: request.planId,
    publicationId: request.publicationId,
    packageId: request.packageId,
    packageVersion: request.packageVersion,
    platform: request.platform,
    kind: request.kind,
    format: "png",
    width: request.width,
    height: request.height,
    slideNumber: request.slideNumber,
    path: filename,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    altText: request.altText,
    createdAt: request.createdAt,
  });
  return { asset, bytes };
}

function socialSvg(request: RenderRequest) {
  const margin = Math.round(request.width * 0.075);
  const titleSize = request.height > request.width ? 72 : 58;
  const bodySize = request.height > request.width ? 40 : 30;
  const titleLines = wrap(
    request.title,
    request.height > request.width ? 22 : 34,
    4,
  );
  const bodyLines = wrap(
    request.body ?? "",
    request.height > request.width ? 34 : 54,
    5,
  );
  const titleY = request.height > request.width ? 270 : 190;
  const titleMarkup = textLines(
    titleLines,
    margin,
    titleY,
    titleSize,
    Math.round(titleSize * 1.12),
    colors.white,
    760,
  );
  const bodyY = titleY + titleLines.length * Math.round(titleSize * 1.12) + 54;
  const bodyMarkup = textLines(
    bodyLines,
    margin,
    bodyY,
    bodySize,
    Math.round(bodySize * 1.35),
    colors.muted,
    480,
  );
  const number = request.slideNumber
    ? `<text x="${request.width - margin}" y="${margin}" text-anchor="end" fill="${colors.muted}" font-size="26" font-family="Arial, sans-serif">${request.slideNumber}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${request.width}" height="${request.height}" viewBox="0 0 ${request.width} ${request.height}">
  <rect width="${request.width}" height="${request.height}" fill="${colors.ink}"/>
  <circle cx="${request.width * 0.9}" cy="${request.height * 0.04}" r="${request.width * 0.34}" fill="${colors.accent}" opacity="0.16"/>
  <circle cx="${request.width * 0.08}" cy="${request.height * 0.95}" r="${request.width * 0.25}" fill="${colors.accent}" opacity="0.08"/>
  <rect x="${margin}" y="${margin}" width="88" height="8" rx="4" fill="${colors.accent}"/>
  <text x="${margin}" y="${margin + 58}" fill="${colors.muted}" font-size="24" font-weight="700" letter-spacing="3" font-family="Arial, sans-serif">${escapeXml(request.eyebrow.toUpperCase())}</text>
  ${number}
  ${titleMarkup}
  ${bodyMarkup}
  <line x1="${margin}" y1="${request.height - margin - 45}" x2="${request.width - margin}" y2="${request.height - margin - 45}" stroke="${colors.surface}" stroke-width="2"/>
  <text x="${margin}" y="${request.height - margin}" fill="${colors.paper}" font-size="24" font-weight="700" font-family="Arial, sans-serif">DEEP / LOOSE THREAD</text>
  <text x="${request.width - margin}" y="${request.height - margin}" text-anchor="end" fill="${colors.muted}" font-size="20" font-family="Arial, sans-serif">${escapeXml(request.footer ?? "Independent technology analysis")}</text>
</svg>`;
}

function textLines(
  lines: string[],
  x: number,
  y: number,
  size: number,
  gap: number,
  fill: string,
  weight: number,
) {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * gap}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="Arial, sans-serif">${escapeXml(line)}</text>`,
    )
    .join("\n");
}

function wrap(value: string, max: number, limit: number) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > max) {
      if (lines.length === limit) break;
      lines.push(word);
    } else lines[lines.length - 1] = `${current} ${word}`;
  }
  if (
    words.length &&
    lines.join(" ").length < value.trim().length &&
    lines.length
  )
    lines[lines.length - 1] = `${lines.at(-1)!.replace(/[.…]+$/, "")}…`;
  return lines;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
