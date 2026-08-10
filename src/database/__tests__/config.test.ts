import { describe, expect, it } from "vitest";

import { readStorageConfiguration } from "../config";
import { redactDatabaseSecrets } from "../errors";

describe("durable storage configuration", () => {
  it("defaults development to file storage", () => {
    expect(readStorageConfiguration({ NODE_ENV: "development" }).backend).toBe(
      "file",
    );
  });
  it("fails closed for production file storage", () => {
    expect(() =>
      readStorageConfiguration({
        NODE_ENV: "production",
        STORAGE_BACKEND: "file",
      }),
    ).toThrow(/requires STORAGE_BACKEND=postgres/);
  });
  it("requires an actual URL for Postgres", () => {
    expect(() =>
      readStorageConfiguration({
        NODE_ENV: "development",
        STORAGE_BACKEND: "postgres",
      }),
    ).toThrow(/requires.*DATABASE_URL/);
  });
  it("rejects arbitrary schema identifiers", () => {
    expect(() =>
      readStorageConfiguration({
        NODE_ENV: "development",
        STORAGE_BACKEND: "postgres",
        DATABASE_URL: "postgresql://localhost/db",
        DATABASE_SCHEMA: "public",
      }),
    ).toThrow(/DATABASE_SCHEMA/);
  });
  it("redacts database URLs", () => {
    expect(
      redactDatabaseSecrets("failed postgresql://deep:secret@db.example/test"),
    ).not.toContain("secret");
  });
});
