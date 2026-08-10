import { describe, expect, it, vi } from "vitest";

import { createTelegramWebhookHandler } from "./webhook";
import { messageUpdate } from "./testing";

const secret = "fixture-webhook-secret";

function request(body: string, headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
      ...headers,
    },
    body,
  });
}

describe("Telegram webhook security", () => {
  it("accepts a valid signed update", async () => {
    const processUpdate = vi
      .fn()
      .mockResolvedValue({ status: "processed", action: "/start" });
    const response = await createTelegramWebhookHandler({
      secrets: [secret],
      service: { processUpdate },
    })(request(JSON.stringify(messageUpdate(1, "/start"))));
    expect(response.status).toBe(200);
    expect(processUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", {}, 401],
    ["invalid", { "x-telegram-bot-api-secret-token": "wrong" }, 401],
    ["wrong content type", { "content-type": "text/plain" }, 415],
  ] as const)("rejects %s security input", async (_name, overrides, status) => {
    const base =
      _name === "missing"
        ? { "x-telegram-bot-api-secret-token": "" }
        : overrides;
    const response = await createTelegramWebhookHandler({
      secrets: [secret],
      service: { processUpdate: vi.fn() },
    })(request("{}", base));
    expect(response.status).toBe(status);
  });

  it("rejects oversized declared and actual bodies", async () => {
    const handler = createTelegramWebhookHandler({
      secrets: [secret],
      bodyLimit: 16,
      service: { processUpdate: vi.fn() },
    });
    expect(
      (await handler(request("{}", { "content-length": "17" }))).status,
    ).toBe(413);
    expect(
      (await handler(request(JSON.stringify({ value: "x".repeat(40) }))))
        .status,
    ).toBe(413);
  });

  it("rejects invalid JSON and invalid Telegram updates", async () => {
    const handler = createTelegramWebhookHandler({
      secrets: [secret],
      service: { processUpdate: vi.fn() },
    });
    expect((await handler(request("{"))).status).toBe(400);
    expect(
      (await handler(request(JSON.stringify({ update_id: 1 })))).status,
    ).toBe(400);
  });

  it("never exposes service stack traces", async () => {
    const handler = createTelegramWebhookHandler({
      secrets: [secret],
      service: {
        processUpdate: vi
          .fn()
          .mockRejectedValue(new Error("private stack secret")),
      },
    });
    const response = await handler(
      request(JSON.stringify(messageUpdate(1, "/start"))),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private stack secret");
  });
});
