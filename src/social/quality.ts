import { publicSourceUrl } from "../publication/transform";
import { sha256 } from "../writing/task";
import type { SocialConfig } from "./config";
import {
  socialQualitySchema,
  type PlatformContentItem,
  type SocialClaim,
  type SocialQuality,
} from "./models";
const banned = [
  "this changes everything",
  "you won’t believe",
  "you won't believe",
  "the truth about",
  "everyone is wrong",
  "game changer",
  "must buy",
  "is dead",
  "is obsolete",
  "agree?",
];
export function scrubSocial(value: string) {
  const checks: [RegExp, string][] = [
    [/telegram(?:User|Chat|Update|Message)?Id/i, "Telegram metadata"],
    [
      /(?:bot\d{6,}:|gh[pousr]_|vercel_[A-Za-z0-9_-]+|webhook[_-]?secret|(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S+)/i,
      "secret pattern",
    ],
    [
      /(?:\/Users\/|[A-Z]:\\|data\/(?:research|review|tasks\/research|writing\/drafts))/i,
      "private path",
    ],
    [/(?:draft|review|claim|source)_[a-f0-9]{16,}/i, "internal identifier"],
    [
      /https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i,
      "private URL",
    ],
    [
      /[?&](?:token|key|secret|password|signature|utm_[^=]*)=/i,
      "sensitive query parameter",
    ],
    [/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, "email address"],
  ];
  const hit = checks.find(([r]) => r.test(value));
  if (hit) throw new Error(`Private social data blocked: ${hit[1]}`);
}
const words = (x: string) =>
  x
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .match(/[a-z0-9]+/g) ?? [];
function similarity(a: string, b: string) {
  const aa = new Set(words(a)),
    bb = new Set(words(b));
  if (!aa.size) return 0;
  let n = 0;
  for (const x of aa) if (bb.has(x)) n++;
  return n / new Set([...aa, ...bb]).size;
}
function emojiCount(x: string) {
  return [...x.matchAll(/\p{Extended_Pictographic}/gu)].length;
}
export function validateSocialItem(
  item: PlatformContentItem,
  input: {
    canonicalUrl: string;
    articleText: string;
    claims: SocialClaim[];
    config: SocialConfig;
    now: string;
    packageId: string;
    packageVersion: number;
    requiredDisclosures?: string[];
  },
): SocialQuality {
  const text = [
    item.title,
    item.text,
    ...(item.thread ?? []),
    ...(item.slides ?? []).flatMap((x) => [
      x.headline,
      x.body,
      x.visualDirection,
      x.altText,
    ]),
  ]
    .filter(Boolean)
    .join("\n");
  scrubSocial(text);
  const blocking: string[] = [],
    warnings: string[] = [],
    fit: string[] = [],
    disclosures: string[] = [],
    visual: string[] = [];
  const limit = input.config.characterLimits[item.platform];
  if (item.contentType === "x_thread") {
    if (
      (item.thread?.length ?? 0) < input.config.xThreadMin ||
      (item.thread?.length ?? 0) > input.config.xThreadMax
    )
      blocking.push("X thread length is outside configured limits");
    if (item.thread?.some((x) => x.length > limit))
      blocking.push("An X thread post exceeds the character limit");
    if (new Set(item.thread).size !== (item.thread?.length ?? 0))
      blocking.push("X thread contains duplicate posts");
  } else if (item.contentType !== "instagram_carousel" && text.length > limit)
    blocking.push(
      `${item.platform} content exceeds configured character limit`,
    );
  if (item.platform === "linkedin") {
    const wc = words(item.text ?? "").length;
    if (wc < 120 || wc > 250)
      warnings.push("LinkedIn post is outside the recommended 120–250 words");
    if (!text.includes(input.canonicalUrl))
      blocking.push("LinkedIn post is missing the canonical link");
  }
  if (
    item.platform === "x" &&
    item.contentType === "x_post" &&
    item.link &&
    item.link !== input.canonicalUrl
  )
    blocking.push("X link does not match canonical URL");
  if (
    item.platform === "instagram" &&
    item.contentType === "instagram_carousel"
  ) {
    const count = item.slides?.length ?? 0;
    if (count < input.config.carouselMin || count > input.config.carouselMax)
      blocking.push("Instagram slide count is outside configured limits");
    if (item.slides?.some((x) => !x.altText.trim()))
      blocking.push("Instagram slide alt text is missing");
    if (item.slides?.some((x) => x.body.length > 400))
      blocking.push("Instagram slide copy is too dense");
  }
  if (item.platform === "medium") {
    if (!text.includes(input.canonicalUrl))
      blocking.push("Medium adaptation lacks canonical guidance");
    if (/status:\s*published/i.test(text))
      blocking.push("Medium output attempts to set publication status");
  }
  if (item.hashtags.length > input.config.hashtagLimits[item.platform])
    blocking.push("Hashtag limit exceeded");
  const emojis = emojiCount(text);
  if (emojis > input.config.emojiLimits[item.platform])
    blocking.push("Emoji limit exceeded");
  for (const phrase of banned)
    if (text.toLowerCase().includes(phrase))
      warnings.push(`Unsafe hook: ${phrase}`);
  for (const ref of item.claimReferences)
    if (!input.claims.some((x) => x.id === ref))
      blocking.push(`Unknown published claim reference: ${ref}`);
  const referenced = input.claims.filter((x) =>
    item.claimReferences.includes(x.id),
  );
  const articleNumbers = new Set(
    referenced.flatMap((x) => x.statement.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []),
  );
  for (const number of text.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [])
    if (!articleNumbers.has(number) && !/^\d{1,2}$/.test(number))
      blocking.push(`Unsupported numeric claim: ${number}`);
  if (
    /\bwill\b/i.test(text) &&
    referenced.some((x) => x.claimType === "uncertainty")
  )
    blocking.push("Compression removed uncertainty");
  const impliesHandsOn =
    /\b(?:I|we)\s+(?:tested|used|reviewed)\b|\bmy review\b|\bhands-on\b/i.test(
      text,
    ) && !/\b(?:not|no) hands-on\b/i.test(text);
  if (
    impliesHandsOn &&
    input.articleText.toLowerCase().includes("source-based")
  )
    blocking.push("Social content implies unsupported hands-on experience");
  if (
    input.articleText.toLowerCase().includes("source-based") &&
    ["linkedin", "medium"].includes(item.platform) &&
    !/source-based|not hands-on|no hands-on/i.test(text)
  )
    blocking.push("Source-based disclosure was removed");
  for (const statement of input.requiredDisclosures ?? [])
    if (!text.toLowerCase().includes(statement.toLowerCase()))
      blocking.push("Required commercial relationship disclosure was removed");
  if (
    item.visualBrief &&
    /(official screenshot|photorealistic unreleased|in my hands)/i.test(
      JSON.stringify(item.visualBrief),
    )
  )
    visual.push("Visual brief may misrepresent a product or possession");
  if (visual.length) blocking.push(...visual);
  const copy = similarity(text, input.articleText);
  const copiedParagraph = text
    .split(/\n{2,}/)
    .some((paragraph) =>
      paragraph.length >= 80
        ? input.articleText.includes(paragraph.trim())
        : false,
    );
  if (
    copiedParagraph ||
    (copy >= input.config.copySimilarityBlock && text.length > 500)
  )
    blocking.push("Platform adaptation copies too much of the article");
  else if (copy >= input.config.copySimilarityWarning)
    warnings.push("Platform adaptation has high article overlap");
  if (
    item.suggestedPublishAt &&
    Date.parse(item.suggestedPublishAt) <= Date.parse(input.now)
  )
    blocking.push("Suggested schedule is in the past");
  if (item.link) {
    try {
      const safe = publicSourceUrl(item.link);
      if (safe !== item.link)
        blocking.push("Link contains tracking or sensitive parameters");
    } catch {
      blocking.push("Link is unsafe");
    }
  }
  const status = blocking.length
    ? "blocked"
    : warnings.length
      ? "passed_with_warnings"
      : "passed";
  return socialQualitySchema.parse({
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    platformItemId: item.id,
    platform: item.platform,
    characterCount: text.length,
    wordCount: words(text).length,
    claimAlignment: blocking.some((x) =>
      /claim|uncertainty|hands-on|disclosure|numeric/i.test(x),
    )
      ? "blocked"
      : warnings.length
        ? "warning"
        : "aligned",
    linkValid: !blocking.some((x) => /link|canonical/i.test(x)),
    hookWarnings: warnings.filter((x) => x.startsWith("Unsafe hook")),
    repetition: [],
    platformFit: fit,
    disclosureCompliance: disclosures,
    hashtagCount: item.hashtags.length,
    emojiCount: emojis,
    copySimilarity: copy,
    timingValid: !blocking.some((x) => /schedule/.test(x)),
    visualRisk: visual,
    blockingIssues: [...new Set(blocking)],
    warnings: [...new Set(warnings)],
    status,
    createdAt: input.now,
  });
}
export const contentHash = (item: PlatformContentItem) =>
  sha256(
    JSON.stringify({
      platform: item.platform,
      contentType: item.contentType,
      text: item.text,
      title: item.title,
      slides: item.slides,
      thread: item.thread,
      hashtags: item.hashtags,
      link: item.link,
      altText: item.altText,
      visualBrief: item.visualBrief,
    }),
  );
