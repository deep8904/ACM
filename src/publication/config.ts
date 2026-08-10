import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const safePath = z
  .string()
  .regex(/^(?![/.])(?!.*(?:^|\/)\.)(?!.*\.\.)(?!.*\\)[A-Za-z0-9_/{}/.-]+$/);
export const publicationConfigSchema = z
  .object({
    mode: z.enum(["fixture", "github"]),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    defaultBranch: z
      .string()
      .regex(/^(?![/.])(?!.*\.\.)(?!.*[~^:?*\[\\])[A-Za-z0-9._/-]+$/),
    branchStrategy: z.enum(["direct", "publication_branch"]),
    contentRoot: safePath,
    pathPattern: safePath.refine(
      (x) => x.includes("{slug}") && x.endsWith(".mdx"),
      "pathPattern must contain {slug} and end in .mdx",
    ),
    siteOrigin: z.string().url(),
    blogRoutePrefix: z.string().regex(/^\/[A-Za-z0-9/_-]*$/),
    citationStyle: z.literal("numbered_footnotes"),
    commitMessagePattern: z.string().refine((x) => x.includes("{title}")),
    deploymentProvider: z.enum(["mock", "vercel_git", "manual"]),
    deploymentPolicy: z.enum(["required", "best_effort", "manual"]),
    deploymentTimeoutSeconds: z.number().int().min(5).max(3600),
    pollIntervalSeconds: z.number().int().min(1).max(300),
    publicPageVerification: z.boolean(),
    maximumAttempts: z.number().int().min(1).max(10),
    scheduledGraceMinutes: z.number().int().min(0).max(10080),
    claimTimeoutMinutes: z.number().int().min(1).max(1440),
    notifications: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.pollIntervalSeconds >= v.deploymentTimeoutSeconds)
      ctx.addIssue({
        code: "custom",
        message: "poll interval must be less than deployment timeout",
      });
    if (v.mode === "github" && !v.siteOrigin.startsWith("https://"))
      ctx.addIssue({
        code: "custom",
        message: "production site origin must use HTTPS",
      });
  });
export type PublicationConfig = z.infer<typeof publicationConfigSchema>;
export async function loadPublicationConfig(path: string) {
  return publicationConfigSchema.parse(parse(await readFile(path, "utf8")));
}
