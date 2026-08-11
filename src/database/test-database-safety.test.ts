import { describe, expect, it } from "vitest";

import { safeTestDatabaseUrl } from "./test-database-safety";

describe("Postgres test database safety", () => {
  it("rejects the configured application database even with different credentials", () => {
    expect(() =>
      safeTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://test:secret@db.example.com/postgres",
        DATABASE_URL: "postgresql://prod:other@db.example.com/postgres",
        CONFIRM_DISPOSABLE_TEST_DATABASE:
          "I_UNDERSTAND_THIS_DATABASE_WILL_BE_MUTATED",
      }),
    ).toThrow(/must not target/);
  });

  it("requires explicit confirmation for a remote disposable database", () => {
    expect(() =>
      safeTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://test:secret@test.example.com/postgres",
      }),
    ).toThrow(/CONFIRM_DISPOSABLE_TEST_DATABASE/);
  });

  it("allows an unambiguous local test database", () => {
    expect(
      safeTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://test:secret@127.0.0.1/acm_test",
      }),
    ).toBe("postgresql://test:secret@127.0.0.1/acm_test");
  });
});
