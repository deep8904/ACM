import { sha256 } from "../writing/task";
import type { ProductionPublicationArtifact } from "../publication/models";
import { toPlainText } from "../writing/mdx";
import type { SocialConfig } from "./config";
import {
  socialClaimSchema,
  type SocialClaim,
  type SocialPlatform,
} from "./models";
export function publicArticleText(mdx: string) {
  return toPlainText(mdx.replace(/^---\n[\s\S]*?\n---\n/, ""));
}
export function createClaimIndex(mdx: string): SocialClaim[] {
  const body = publicArticleText(mdx),
    lines = body.split(/\n+/);
  const section = "Article";
  const urls = [...mdx.matchAll(/https:\/\/[^\s)\]]+/g)].map((x) =>
    (x[0] ?? "").replace(/[.,]$/, ""),
  );
  const out: SocialClaim[] = [];
  for (const line of lines) {
    if (line.length < 20) continue;
    const statement = line.trim().slice(0, 1000);
    const lower = statement.toLowerCase();
    const claimType = /source-based|not hands-on|no hands-on/.test(lower)
      ? "disclosure"
      : /\b(?:may|might|could|suggests?|uncertain|unknown)\b/.test(lower)
        ? "uncertainty"
        : /\b(?:should|recommend|wait|buy|skip)\b/.test(lower)
          ? "recommendation"
          : /\d/.test(statement)
            ? "fact"
            : "analysis";
    const fingerprint = sha256(statement);
    out.push(
      socialClaimSchema.parse({
        id: `pubclaim_${fingerprint.slice(0, 16)}`,
        section,
        statement,
        fingerprint,
        claimType,
        compressionAllowed: claimType === "analysis",
        publicSourceUrls: [...new Set(urls)].slice(0, 10),
      }),
    );
    if (out.length >= 40) break;
  }
  return out;
}
export function suggestTime(
  platform: SocialPlatform,
  from: Date,
  config: SocialConfig,
) {
  const window = config.scheduleWindows[platform],
    candidate = new Date(from);
  candidate.setUTCDate(candidate.getUTCDate() + window.delayDays);
  for (let i = 0; i < 14; i++) {
    const phoenixDay = new Date(candidate.valueOf() - 7 * 3600000).getUTCDay();
    if (window.days.includes(phoenixDay)) {
      const y = new Date(candidate.valueOf() - 7 * 3600000);
      const at = new Date(
        Date.UTC(
          y.getUTCFullYear(),
          y.getUTCMonth(),
          y.getUTCDate(),
          window.hour + 7,
        ),
      );
      if (at > from) return at.toISOString();
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  throw new Error("No future schedule window available");
}
export function buildSocialTask(input: {
  record: ProductionPublicationArtifact;
  mdx: string;
  platforms: SocialPlatform[];
  version: number;
  config: SocialConfig;
  brand: {
    audience: string;
    writing: string;
    editorial: string;
    design: string;
  };
  prompt: string;
  now: Date;
  revision?: unknown;
}) {
  const claims = createClaimIndex(input.mdx);
  const plain = publicArticleText(input.mdx).slice(
    0,
    input.config.claimContextCharacters,
  );
  const timing = input.platforms.map((platform) => ({
    platform,
    publishAt: suggestTime(platform, input.now, input.config),
    timezone: input.config.timezone,
  }));
  const compact = {
    publicationId: input.record.id,
    articleContentHash: input.record.contentHash,
    packageVersion: input.version,
    title: input.record.title,
    slug: input.record.slug,
    canonicalUrl: input.record.canonicalUrl,
    publishedAt: input.record.publishedAt,
    article: plain,
    platforms: input.platforms,
    timingSuggestions: timing,
    revision: input.revision,
  };
  const rules = Object.fromEntries(
    input.platforms.map((p) => [
      p,
      {
        characterLimit: input.config.characterLimits[p],
        hashtagLimit: input.config.hashtagLimits[p],
        emojiLimit: input.config.emojiLimits[p],
        xThread:
          p === "x"
            ? { min: input.config.xThreadMin, max: input.config.xThreadMax }
            : undefined,
        carousel:
          p === "instagram"
            ? { min: input.config.carouselMin, max: input.config.carouselMax }
            : undefined,
        manualPostingOnly: true,
      },
    ]),
  );
  const taskHash = sha256(
    JSON.stringify({
      compact,
      rules,
      claims,
      brand: input.brand,
      prompt: input.prompt,
    }),
  );
  const instructions = `# Social generation task\n\n${input.prompt}\n\nUse only social-input.json, claim-index.json, platform-rules.json, and the supplied brand/visual rules. Do not browse. Do not invent facts, prices, features, quotes, statistics, urgency, controversy, testing, or possession. Preserve uncertainty, regional limits, non-hands-on disclosures, and the exact canonical link. Adapt each platform rather than copying the article introduction. Return JSON only matching expected-output.schema.json. Do not post, schedule, create accounts, invoke tools, or generate images. Stop after producing the package.\n\nTask hash: ${taskHash}\n`;
  return {
    taskHash,
    claims,
    compact,
    rules,
    timing,
    files: {
      "social-generation.md": instructions,
      "social-input.json": `${JSON.stringify(compact, null, 2)}\n`,
      "platform-rules.json": `${JSON.stringify(rules, null, 2)}\n`,
      "claim-index.json": `${JSON.stringify(claims, null, 2)}\n`,
      "visual-guidelines.md": `${input.brand.design}\n\nNo fake screenshots, unreleased hardware renders, implied possession/testing, unauthorized logos, or unlicensed assets. Image prompts are text plans only.\n`,
    },
  };
}
