import { sha256 } from "../writing/task";
import type { SocialConfig } from "./config";
import {
  platformContentItemSchema,
  type PlatformContentItem,
  type SocialClaim,
  type SocialPlatform,
} from "./models";
import type { RenderRequest } from "./renderer";

export function buildDeterministicSocialContent(input: {
  planId: string;
  publicationId: string;
  packageId: string;
  packageVersion: number;
  articleContentHash: string;
  title: string;
  canonicalUrl: string;
  claims: SocialClaim[];
  platforms: SocialPlatform[];
  config: SocialConfig;
  now: string;
}) {
  const claims = usefulClaims(input.claims);
  const main = claims[0]?.statement ?? input.title;
  const second =
    claims[1]?.statement ??
    "The practical impact depends on the reader's workflow.";
  const limitation =
    claims.find((claim) =>
      ["uncertainty", "disclosure"].includes(claim.claimType),
    )?.statement ??
    "The available evidence still has limits, so verify compatibility before acting.";
  const items: PlatformContentItem[] = [];
  const renders: Omit<RenderRequest, "createdAt">[] = [];
  const refs = claims.slice(0, 6).map((claim) => claim.id);

  for (const platform of input.platforms) {
    if (platform === "linkedin") {
      const text = `The useful part of ${input.title} is easier to see when the announcement is separated from the practical effect.\n\nArticle finding: ${main}\n\nPractical implication: ${second}\n\nThe limitation: ${limitation}\n\nThis is a source-based summary, not hands-on testing. Read the full analysis: ${input.canonicalUrl}`;
      items.push(
        item(input, platform, "linkedin_post", {
          text,
          link: input.canonicalUrl,
          altText: brandedAlt(input.title, "landscape analysis card"),
          claimReferences: refs,
        }),
      );
      renders.push(
        render(
          input,
          platform,
          "social_card",
          1200,
          627,
          input.title,
          "LinkedIn briefing",
          concise(main, 150),
          brandedAlt(input.title, "landscape analysis card"),
        ),
      );
    } else if (platform === "x") {
      const post = concise(
        `${input.title}: ${main} ${input.canonicalUrl}`,
        275,
      );
      const thread = [
        concise(`${input.title}\n\n${main}`, 270),
        concise(`Why it matters: ${second}`, 270),
        concise(`The limitation: ${limitation}`, 270),
        concise(`Full source-based analysis: ${input.canonicalUrl}`, 270),
      ];
      items.push(
        item(input, platform, "x_post", {
          text: post,
          link: input.canonicalUrl,
          altText: brandedAlt(input.title, "landscape summary card"),
          claimReferences: refs,
        }),
      );
      items.push(
        item(input, platform, "x_thread", {
          thread,
          link: input.canonicalUrl,
          altText: brandedAlt(input.title, "landscape summary card"),
          claimReferences: refs,
        }),
      );
      renders.push(
        render(
          input,
          platform,
          "social_card",
          1200,
          627,
          input.title,
          "Loose Thread / X",
          concise(main, 150),
          brandedAlt(input.title, "landscape summary card"),
        ),
      );
    } else if (platform === "instagram") {
      const slideIdeas = [
        [input.title, "A concise source-based briefing."],
        ["What changed", main],
        ["Why it matters", second],
        ["What the evidence supports", claims[2]?.statement ?? main],
        ["The limitation", limitation],
        [
          "Practical takeaway",
          claims.find((claim) => claim.claimType === "recommendation")
            ?.statement ??
            "Read the evidence, check compatibility, and decide from your own workflow.",
        ],
      ] as const;
      const slides = slideIdeas.map(([headline, body], index) => ({
        slideNumber: index + 1,
        headline: concise(headline, 116),
        body: concise(body, 260),
        visualDirection:
          "Deep / Loose Thread editorial card using abstract blue geometry, strong typography, and no third-party logos or fabricated UI.",
        altText: `Slide ${index + 1} of 6. ${headline}. ${concise(body, 260)}`,
      }));
      items.push(
        item(input, platform, "instagram_carousel", {
          slides,
          altText: concise(slides.map((slide) => slide.altText).join(" "), 980),
          claimReferences: refs,
        }),
      );
      items.push(
        item(input, platform, "instagram_caption", {
          text: `${input.title}\n\nArticle finding: ${concise(main, 500)}\n\nKeep in perspective: ${concise(limitation, 390)}\n\nFull article at the link in bio.`,
          altText: concise(slides.map((slide) => slide.altText).join(" "), 980),
          claimReferences: refs,
          hashtags: ["#Technology", "#TechAnalysis", "#LooseThread"],
        }),
      );
      for (const slide of slides)
        renders.push(
          render(
            input,
            platform,
            "carousel_slide",
            1080,
            1350,
            slide.headline,
            `Carousel ${slide.slideNumber}/6`,
            slide.body,
            slide.altText,
            slide.slideNumber,
          ),
        );
    } else {
      const text = `## What changed\n\nThe published analysis finds: ${main}\n\n## Why it matters\n\nThe practical implication is: ${second}\n\n## What to keep in perspective\n\nThe evidence also keeps this limitation in view: ${limitation}\n\nThis is a source-based adaptation, not hands-on testing. Two branded editorial images are provided for placement after the opening and before the limitation section.\n\nOriginally published at ${input.canonicalUrl}`;
      items.push(
        item(input, platform, "medium_adaptation", {
          title: input.title,
          text,
          link: input.canonicalUrl,
          altText: `Two abstract Deep / Loose Thread editorial illustrations accompanying ${input.title}.`,
          claimReferences: refs,
        }),
      );
      renders.push(
        render(
          input,
          platform,
          "medium_inline",
          1200,
          675,
          input.title,
          "Deep / Loose Thread",
          concise(main, 170),
          brandedAlt(input.title, "wide editorial illustration"),
          1,
        ),
      );
      renders.push(
        render(
          input,
          platform,
          "medium_inline",
          1200,
          675,
          "What to keep in perspective",
          "Source-based analysis",
          concise(limitation, 170),
          brandedAlt(input.title, "wide limitation-section illustration"),
          2,
        ),
      );
    }
  }
  return { items, renders };
}

function item(
  input: Parameters<typeof buildDeterministicSocialContent>[0],
  platform: SocialPlatform,
  contentType: PlatformContentItem["contentType"],
  value: Partial<PlatformContentItem>,
) {
  const fingerprint = sha256(
    `${input.planId}:${input.packageId}:${platform}:${contentType}`,
  );
  return platformContentItemSchema.parse({
    id: `socialitem_${fingerprint.slice(0, 24)}`,
    platform,
    contentType,
    status: "draft",
    hashtags: [],
    characterCount: textOf(value).length,
    sourcePublicationHash: input.articleContentHash,
    warnings: [],
    createdAt: input.now,
    updatedAt: input.now,
    ...value,
  });
}

function render(
  input: Parameters<typeof buildDeterministicSocialContent>[0],
  platform: SocialPlatform,
  kind: RenderRequest["kind"],
  width: number,
  height: number,
  title: string,
  eyebrow: string,
  body: string,
  altText: string,
  slideNumber?: number,
): Omit<RenderRequest, "createdAt"> {
  return {
    planId: input.planId,
    publicationId: input.publicationId,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    platform,
    kind,
    width,
    height,
    title,
    eyebrow,
    body,
    footer: "deep.dev / Loose Thread",
    altText,
    slideNumber,
  };
}

function usefulClaims(claims: SocialClaim[]) {
  return claims
    .map((claim) => ({ ...claim, statement: cleanClaim(claim.statement) }))
    .filter(
      (claim) =>
        claim.statement.length >= 45 && !/^sources?\b/i.test(claim.statement),
    );
}
function cleanClaim(value: string) {
  return value
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\s*Packet v\d+\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
function concise(value: string, max: number) {
  if (value.length <= max) return value;
  const slice = value.slice(0, max - 1);
  const boundary = slice.lastIndexOf(" ");
  return `${slice.slice(0, boundary > max / 2 ? boundary : undefined).replace(/[.,;:!?\s]+$/, "")}…`;
}
function brandedAlt(title: string, format: string) {
  return `Deep / Loose Thread ${format} for “${title}”, with white editorial type, blue abstract geometry, and a dark background.`;
}
function textOf(item: Partial<PlatformContentItem>) {
  return [
    item.title,
    item.text,
    ...(item.thread ?? []),
    ...(item.slides ?? []).flatMap((slide) => [slide.headline, slide.body]),
  ]
    .filter(Boolean)
    .join("\n");
}
