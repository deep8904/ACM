import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { sourceAuthoritySchema, sourceTypeSchema } from "../models/source-item";

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use HTTP or HTTPS");

export const hackerNewsModeSchema = z.enum(["top", "new", "best"]);

export const sourceConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1),
  type: sourceTypeSchema,
  url: httpUrlSchema,
  authority: sourceAuthoritySchema,
  topics: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  maxItems: z.number().int().min(1).max(100).default(20),
  timeoutMs: z.number().int().min(250).max(30_000).default(10_000),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
    .default("en"),
  mode: hackerNewsModeSchema.default("top"),
});

export const sourceConfigFileSchema = z
  .object({
    sources: z.array(sourceConfigSchema).min(1),
  })
  .superRefine(({ sources }, context) => {
    const seen = new Set<string>();
    for (const [index, source] of sources.entries()) {
      if (seen.has(source.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate source id: ${source.id}`,
          path: ["sources", index, "id"],
        });
      }
      seen.add(source.id);
    }
  });

export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type SourceConfigFile = z.infer<typeof sourceConfigFileSchema>;

export class SourceConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceConfigError";
  }
}

export function parseSourceConfigText(text: string): SourceConfigFile {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new SourceConfigError(
      `Source configuration is not valid YAML: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }

  const result = sourceConfigFileSchema.safeParse(document);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new SourceConfigError(`Invalid source configuration: ${details}`);
  }

  return result.data;
}

export async function loadSourceConfig(
  path: string,
): Promise<SourceConfigFile> {
  try {
    return parseSourceConfigText(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SourceConfigError) {
      throw error;
    }
    throw new SourceConfigError(
      `Could not read source configuration at ${path}: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
