import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../telegram/runtime", () => ({
  buildTelegramWebhookHandler: vi.fn(() => {
    throw new Error(
      "failed postgresql://operator:password@db.example/app token=classifiedvalue",
    );
  }),
}));

import { POST } from "./route";

describe("POST /api/telegram/webhook", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a secret-safe construction diagnostic and keeps the response generic", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await POST(
      new Request("https://example.com/api/telegram/webhook", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "telegram_unavailable",
    });
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain("telegram_webhook_unavailable");
    expect(logged).not.toContain("password");
    expect(logged).not.toContain("classifiedvalue");
  });
});
