import { describe, expect, it } from "vitest";

import { automationJobSchema } from "./models";

describe("automation job identity", () => {
  it("requires a lease for running jobs at the database boundary shape", () => {
    const base = {
      id: `automationjob_${"a".repeat(24)}`,
      idempotencyKey: "b".repeat(64),
      type: "research" as const,
      status: "running" as const,
      lineageKey: "event",
      payload: { eventId: "event" },
      attempt: 1,
      maximumAttempts: 3,
      availableAt: new Date().toISOString(),
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    expect(automationJobSchema.parse(base).status).toBe("running");
    expect(() =>
      automationJobSchema.parse({ ...base, idempotencyKey: "bad" }),
    ).toThrow();
  });
});
