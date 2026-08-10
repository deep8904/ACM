import { z } from "zod";

export const EXPECTED_DATABASE_SCHEMA = "content_machine" as const;

export type StorageBackend = "file" | "postgres";

export interface DatabaseConfig {
  url: string;
  directUrl?: string;
  schema: typeof EXPECTED_DATABASE_SCHEMA;
  maxConnections: number;
  connectTimeoutSeconds: number;
  idleTimeoutSeconds: number;
}

const connectionUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "postgres:" || parsed.protocol === "postgresql:"
      );
    } catch {
      return false;
    }
  }, "must be a postgresql:// server-side connection URL");

const environmentSchema = z.object({
  DATABASE_URL: connectionUrlSchema.optional(),
  DATABASE_DIRECT_URL: connectionUrlSchema.optional(),
  DATABASE_SCHEMA: z
    .literal(EXPECTED_DATABASE_SCHEMA)
    .default(EXPECTED_DATABASE_SCHEMA),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(20).default(5),
  DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .default(10),
  DATABASE_IDLE_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(20),
  STORAGE_BACKEND: z.enum(["file", "postgres"]).default("file"),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
});

export interface StorageConfiguration {
  backend: StorageBackend;
  database?: DatabaseConfig;
  production: boolean;
}

export class DatabaseConfigurationError extends Error {
  readonly code = "database_configuration_invalid";

  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export function readStorageConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): StorageConfiguration {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new DatabaseConfigurationError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  const value = parsed.data;
  const production = value.NODE_ENV === "production";

  if (production && value.STORAGE_BACKEND !== "postgres") {
    throw new DatabaseConfigurationError(
      "Production requires STORAGE_BACKEND=postgres and a verified private durable backend; local file workflow state is not durable.",
    );
  }
  if (value.STORAGE_BACKEND === "postgres" && !value.DATABASE_URL) {
    throw new DatabaseConfigurationError(
      "STORAGE_BACKEND=postgres requires the server-side DATABASE_URL.",
    );
  }

  return {
    backend: value.STORAGE_BACKEND,
    production,
    database: value.DATABASE_URL
      ? {
          url: value.DATABASE_URL,
          directUrl: value.DATABASE_DIRECT_URL,
          schema: value.DATABASE_SCHEMA,
          maxConnections: value.DATABASE_MAX_CONNECTIONS,
          connectTimeoutSeconds: value.DATABASE_CONNECT_TIMEOUT_SECONDS,
          idleTimeoutSeconds: value.DATABASE_IDLE_TIMEOUT_SECONDS,
        }
      : undefined,
  };
}

export function safeDatabaseTarget(config: DatabaseConfig): {
  host: string;
  port: string;
  database: string;
  schema: string;
} {
  const parsed = new URL(config.url);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, ""),
    schema: config.schema,
  };
}
