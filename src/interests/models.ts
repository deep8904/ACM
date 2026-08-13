import { z } from "zod";

export const editorialInterestSchema = z
  .object({
    id: z.string().regex(/^interest_[a-f0-9]{24}$/),
    shortId: z.string().regex(/^[a-f0-9]{12}$/),
    name: z.string().min(3).max(120),
    keywords: z.array(z.string().min(1).max(80)).min(1).max(30),
    status: z.enum(["enabled", "disabled", "removed"]),
    isDefault: z.boolean(),
    version: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type EditorialInterest = z.infer<typeof editorialInterestSchema>;

export const DEFAULT_EDITORIAL_INTERESTS = [
  {
    name: "New technology / computer & design technology",
    keywords: [
      "computer technology",
      "design technology",
      "creator technology",
      "figma",
      "display technology",
      "laptop",
    ],
  },
  {
    name: "Product reviews / hardware",
    keywords: [
      "hardware",
      "keyboard",
      "monitor",
      "computer",
      "laptop",
      "buying analysis",
    ],
  },
  {
    name: "Gaming / game design / game-engine news",
    keywords: [
      "gaming",
      "nintendo",
      "game design",
      "game development",
      "game engine",
      "unity",
      "unreal engine",
    ],
  },
  {
    name: "Software / AI news",
    keywords: [
      "software",
      "artificial intelligence",
      "ai",
      "claude",
      "openai",
      "developer tools",
      "model release",
    ],
  },
] as const;
