import { describe, expect, it } from "vitest";

import { buildTelegramWebhookHandler } from "./runtime";

describe("Telegram production durability", () => {
  it("fails closed instead of using Vercel local disk", () => {
    expect(() =>
      buildTelegramWebhookHandler({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "123456:fake-token-long-enough",
        TELEGRAM_ALLOWED_CHAT_IDS: "100",
        TELEGRAM_ALLOWED_USER_IDS: "200",
        TELEGRAM_WEBHOOK_SECRET: "production-fixture-secret",
        TELEGRAM_CALLBACK_SECRET: "production-callback-secret",
      }),
    ).toThrow(/private durable backend/);
  });
});
