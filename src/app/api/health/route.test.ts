import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("GET /api/health", () => {
  const environment = process.env as Record<string, string | undefined>;
  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalStorageBackend = process.env.STORAGE_BACKEND;

  afterEach(() => {
    restore("NODE_ENV", originalNodeEnvironment);
    restore("STORAGE_BACKEND", originalStorageBackend);
    vi.restoreAllMocks();
  });

  it("returns secret-safe production configuration diagnostics", async () => {
    environment.NODE_ENV = "production";
    delete environment.STORAGE_BACKEND;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET();
    const body = (await response.json()) as {
      error: string;
      category: string;
      missing: string[];
      invalid: string[];
    };

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      error: "configuration_invalid",
      category: "configuration",
      invalid: ["STORAGE_BACKEND"],
    });
    expect(body.missing).toContain("STORAGE_BACKEND");
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
