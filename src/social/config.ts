import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { socialPlatformSchema } from "./models";
const limits = z.record(socialPlatformSchema, z.number().int().positive());
const countLimits = z.record(
  socialPlatformSchema,
  z.number().int().nonnegative(),
);
export const socialConfigSchema = z
  .object({
    mode: z.enum(["manual_claude_code", "manual_gemini"]),
    enabledPlatforms: z.array(socialPlatformSchema).min(1),
    defaultPlatforms: z.array(socialPlatformSchema).min(1),
    characterLimits: limits,
    hashtagLimits: countLimits,
    emojiLimits: countLimits,
    xThreadMin: z.number().int().min(2),
    xThreadMax: z.number().int().max(20),
    carouselMin: z.number().int().min(3),
    carouselMax: z.number().int().max(12),
    copySimilarityWarning: z.number().min(0).max(1),
    copySimilarityBlock: z.number().min(0).max(1),
    timezone: z.literal("America/Phoenix"),
    exportRoot: z.string().regex(/^(?![/.])(?!.*\.\.)[A-Za-z0-9_./-]+$/),
    telegramPreviewCharacters: z.number().int().min(100).max(3000),
    approvalCallbackExpiryMinutes: z.number().int().positive(),
    conversationExpiryMinutes: z.number().int().positive(),
    maximumRevisions: z.number().int().min(1).max(20),
    manualPostingDefault: z.literal(true),
    mediumAdaptationMode: z.enum(["plan", "optional_draft"]),
    imagePromptsEnabled: z.boolean(),
    claimContextCharacters: z.number().int().min(1000).max(30000),
    scheduleWindows: z.record(
      socialPlatformSchema,
      z
        .object({
          days: z.array(z.number().int().min(0).max(6)).min(1),
          hour: z.number().int().min(0).max(23),
          delayDays: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.xThreadMin > v.xThreadMax)
      ctx.addIssue({
        code: "custom",
        message: "xThreadMin exceeds xThreadMax",
      });
    if (v.carouselMin > v.carouselMax)
      ctx.addIssue({
        code: "custom",
        message: "carouselMin exceeds carouselMax",
      });
    if (v.copySimilarityWarning >= v.copySimilarityBlock)
      ctx.addIssue({
        code: "custom",
        message: "similarity warning must be below blocker",
      });
    for (const p of v.defaultPlatforms)
      if (!v.enabledPlatforms.includes(p))
        ctx.addIssue({
          code: "custom",
          message: `Default platform ${p} is disabled`,
        });
  });
export type SocialConfig = z.infer<typeof socialConfigSchema>;
export async function loadSocialConfig(path: string) {
  return socialConfigSchema.parse(parse(await readFile(path, "utf8")));
}
