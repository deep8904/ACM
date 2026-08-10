import { describe, expect, it } from "vitest";
import { createSocialCallback, parseSocialCallback } from "../callback";
import { socialConfigSchema } from "../config";
import { platformContentItemSchema, socialClaimSchema } from "../models";
import { scrubSocial, validateSocialItem } from "../quality";
const config = socialConfigSchema.parse({
  mode: "manual_claude_code",
  enabledPlatforms: ["linkedin", "x", "instagram", "medium"],
  defaultPlatforms: ["linkedin", "x"],
  characterLimits: { linkedin: 3000, x: 280, instagram: 2200, medium: 20000 },
  hashtagLimits: { linkedin: 3, x: 2, instagram: 8, medium: 0 },
  emojiLimits: { linkedin: 2, x: 2, instagram: 8, medium: 0 },
  xThreadMin: 4,
  xThreadMax: 8,
  carouselMin: 5,
  carouselMax: 8,
  copySimilarityWarning: 0.35,
  copySimilarityBlock: 0.65,
  timezone: "America/Phoenix",
  exportRoot: "data/social/exports",
  telegramPreviewCharacters: 700,
  approvalCallbackExpiryMinutes: 60,
  conversationExpiryMinutes: 30,
  maximumRevisions: 5,
  manualPostingDefault: true,
  mediumAdaptationMode: "plan",
  imagePromptsEnabled: true,
  claimContextCharacters: 12000,
  scheduleWindows: {
    linkedin: { days: [2, 3, 4], hour: 9, delayDays: 0 },
    x: { days: [1, 2, 3, 4, 5], hour: 11, delayDays: 0 },
    instagram: { days: [1, 2, 3, 4, 5], hour: 18, delayDays: 0 },
    medium: { days: [1, 2, 3, 4, 5], hour: 9, delayDays: 2 },
  },
});
const now = "2026-08-06T12:00:00.000Z",
  hash = "a".repeat(64),
  claim = socialClaimSchema.parse({
    id: "pubclaim_aaaaaaaaaaaaaaaa",
    section: "Article",
    statement: "The release may improve cache behavior in version 4.2.",
    fingerprint: "b".repeat(64),
    claimType: "uncertainty",
    compressionAllowed: false,
    publicSourceUrls: ["https://example.com/source"],
  });
function item(text: string) {
  return platformContentItemSchema.parse({
    id: "socialitem_aaaaaaaaaaaaaaaaaaaaaaaa",
    platform: "linkedin",
    contentType: "linkedin_post",
    status: "draft",
    text,
    hashtags: [],
    link: "https://example.com/blog/cache-update",
    characterCount: text.length,
    claimReferences: [claim.id],
    sourcePublicationHash: hash,
    warnings: [],
    createdAt: now,
    updatedAt: now,
  });
}
describe("social security and callbacks", () => {
  it("signs, parses, and rejects tampered callbacks", () => {
    const x = createSocialCallback(
      "a",
      "abcdef123456",
      2,
      "secret-secret-secret",
    );
    expect(parseSocialCallback(x, "secret-secret-secret")).toMatchObject({
      action: "a",
      version: 2,
    });
    expect(() =>
      parseSocialCallback(x.replace("s:a:", "s:r:"), "secret-secret-secret"),
    ).toThrow(/signature/);
  });
  it("blocks private data and removed uncertainty", () => {
    expect(() => scrubSocial("token=secret-value")).toThrow();
    const q = validateSocialItem(
      item(
        `${"Practical context remains useful. ".repeat(25)}The release will improve version 4.2. https://example.com/blog/cache-update`,
      ),
      {
        canonicalUrl: "https://example.com/blog/cache-update",
        articleText: "The release may improve cache behavior in version 4.2.",
        claims: [claim],
        config,
        now,
        packageId: "socialpackage_aaaaaaaaaaaaaaaaaaaaaaaa",
        packageVersion: 1,
      },
    );
    expect(q.status).toBe("blocked");
    expect(q.blockingIssues.join(" ")).toMatch(/uncertainty/i);
  });
  it("rejects impossible config", () => {
    expect(() =>
      socialConfigSchema.parse({ ...config, xThreadMin: 9, xThreadMax: 4 }),
    ).toThrow();
  });
  it("enforces X thread and Medium canonical rules", () => {
    const x = platformContentItemSchema.parse({
      ...item("Safe LinkedIn body"),
      id: "socialitem_bbbbbbbbbbbbbbbbbbbbbbbb",
      platform: "x",
      contentType: "x_thread",
      text: undefined,
      thread: ["duplicate", "duplicate", "third", "fourth"],
      link: "https://example.com/blog/cache-update",
    });
    expect(
      validateSocialItem(x, {
        canonicalUrl: "https://example.com/blog/cache-update",
        articleText: claim.statement,
        claims: [claim],
        config,
        now,
        packageId: "socialpackage_aaaaaaaaaaaaaaaaaaaaaaaa",
        packageVersion: 1,
      }).blockingIssues,
    ).toContain("X thread contains duplicate posts");
    const medium = platformContentItemSchema.parse({
      ...item("An adaptation plan without a link"),
      id: "socialitem_cccccccccccccccccccccccc",
      platform: "medium",
      contentType: "medium_adaptation",
      link: undefined,
    });
    expect(
      validateSocialItem(medium, {
        canonicalUrl: "https://example.com/blog/cache-update",
        articleText: claim.statement,
        claims: [claim],
        config,
        now,
        packageId: "socialpackage_aaaaaaaaaaaaaaaaaaaaaaaa",
        packageVersion: 1,
      }).status,
    ).toBe("blocked");
  });
});
export { config };
