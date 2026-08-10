import { DatabaseConfigurationError } from "../database/config";
import { REQUIRED_PRODUCTION_ENVIRONMENT } from "./readiness";

export type HealthFailurePhase = "configuration" | "database_readiness";

export function diagnoseHealthFailure(
  error: unknown,
  phase: HealthFailurePhase,
  environment: NodeJS.ProcessEnv = process.env,
  checkedAt = new Date(),
) {
  const missing = REQUIRED_PRODUCTION_ENVIRONMENT.filter(
    (name) => !environment[name],
  );
  const configurationFailure =
    phase === "configuration" || error instanceof DatabaseConfigurationError;

  return {
    ready: false,
    error: configurationFailure
      ? "configuration_invalid"
      : "database_unavailable",
    category: configurationFailure ? "configuration" : "database",
    database: {
      healthy: false,
      status: configurationFailure ? "not_checked" : "unavailable",
    },
    components: {
      database: configurationFailure ? "not_checked" : "unavailable",
      webhook: "unknown",
      scheduler: "unknown",
      schedulerSource: "unknown",
      worker: "unknown",
      github:
        environment.BLOG_GITHUB_TOKEN && environment.BLOG_REPOSITORY
          ? "configured"
          : "missing",
      vercel:
        environment.VERCEL_DEPLOYMENT_METADATA_SOURCE === "github" ||
        (environment.VERCEL_TOKEN && environment.VERCEL_PROJECT_ID)
          ? "configured"
          : "missing",
      llm: environment.GOOGLE_AI_API_KEY ? "configured" : "missing",
    },
    missing,
    invalid: configurationFailure ? invalidConfigurationNames(environment) : [],
    checkedAt: checkedAt.toISOString(),
  };
}

function invalidConfigurationNames(environment: NodeJS.ProcessEnv) {
  const invalid: string[] = [];
  if (
    environment.NODE_ENV === "production" &&
    environment.STORAGE_BACKEND !== "postgres"
  ) {
    invalid.push("STORAGE_BACKEND");
  }
  if (environment.DATABASE_URL && !isPostgresUrl(environment.DATABASE_URL)) {
    invalid.push("DATABASE_URL");
  }
  if (
    environment.DATABASE_DIRECT_URL &&
    !isPostgresUrl(environment.DATABASE_DIRECT_URL)
  ) {
    invalid.push("DATABASE_DIRECT_URL");
  }
  if (
    environment.DATABASE_SCHEMA &&
    environment.DATABASE_SCHEMA !== "content_machine"
  ) {
    invalid.push("DATABASE_SCHEMA");
  }
  return invalid;
}

function isPostgresUrl(value: string) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}
