import { describe, expect, it } from "vitest";

import { DatabaseConfigurationError } from "../database/config";
import { diagnoseHealthFailure } from "./health-diagnostics";

describe("health failure diagnostics", () => {
  const checkedAt = new Date("2026-08-10T06:00:00.000Z");

  it("identifies the production storage guard without exposing values", () => {
    const result = diagnoseHealthFailure(
      new DatabaseConfigurationError("production storage rejected"),
      "configuration",
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://user:secret@example.test/database",
      },
      checkedAt,
    );

    expect(result).toMatchObject({
      ready: false,
      error: "configuration_invalid",
      category: "configuration",
      database: { healthy: false, status: "not_checked" },
      invalid: ["STORAGE_BACKEND"],
      checkedAt: checkedAt.toISOString(),
    });
    expect(result.missing).toContain("STORAGE_BACKEND");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("example.test");
  });

  it("distinguishes database runtime failures", () => {
    const result = diagnoseHealthFailure(
      new Error("connection refused at a private host"),
      "database_readiness",
      { NODE_ENV: "production", STORAGE_BACKEND: "postgres" },
      checkedAt,
    );

    expect(result).toMatchObject({
      ready: false,
      error: "database_unavailable",
      category: "database",
      database: { healthy: false, status: "unavailable" },
      invalid: [],
    });
    expect(JSON.stringify(result)).not.toContain("private host");
  });

  it("reports invalid database field names but never their values", () => {
    const result = diagnoseHealthFailure(
      new DatabaseConfigurationError("invalid environment"),
      "configuration",
      {
        NODE_ENV: "production",
        STORAGE_BACKEND: "postgres",
        DATABASE_URL: "not-a-url-with-secret",
        DATABASE_DIRECT_URL: "https://secret.example.test/database",
        DATABASE_SCHEMA: "public",
      },
      checkedAt,
    );

    expect(result.invalid).toEqual([
      "DATABASE_URL",
      "DATABASE_DIRECT_URL",
      "DATABASE_SCHEMA",
    ]);
    expect(JSON.stringify(result)).not.toContain("not-a-url-with-secret");
    expect(JSON.stringify(result)).not.toContain("secret.example.test");
  });
});
