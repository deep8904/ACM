import { describe, expect, it } from "vitest";

import { authorizeActor } from "./authorization";
import { parseTelegramEnvironment } from "./config";

const actor = { chatId: "100", userId: "200", chatType: "private" as const };

describe("Telegram authorization", () => {
  it("requires both an allowed chat and allowed user", () => {
    const config = parseTelegramEnvironment({
      TELEGRAM_ALLOWED_CHAT_IDS: "100",
      TELEGRAM_ALLOWED_USER_IDS: "200",
    });
    expect(() => authorizeActor(actor, config)).not.toThrow();
    expect(() => authorizeActor({ ...actor, chatId: "101" }, config)).toThrow(
      /not authorized/,
    );
    expect(() => authorizeActor({ ...actor, userId: "201" }, config)).toThrow(
      /not authorized/,
    );
  });

  it("fails closed when authorization configuration is missing", () => {
    expect(() => authorizeActor(actor, parseTelegramEnvironment({}))).toThrow(
      /not configured/,
    );
  });

  it("parses chat and user ID lists strictly", () => {
    const config = parseTelegramEnvironment({
      TELEGRAM_ALLOWED_CHAT_IDS: "100,-200,100",
      TELEGRAM_ALLOWED_USER_IDS: "300,400",
    });
    expect(config.TELEGRAM_ALLOWED_CHAT_IDS).toEqual(["100", "-200"]);
    expect(config.TELEGRAM_ALLOWED_USER_IDS).toEqual(["300", "400"]);
    expect(() =>
      parseTelegramEnvironment({ TELEGRAM_ALLOWED_USER_IDS: "-300" }),
    ).toThrow();
  });

  it("allows an explicitly configured group only for an allowed member", () => {
    const config = parseTelegramEnvironment({
      TELEGRAM_ALLOWED_CHAT_IDS: "-1001",
      TELEGRAM_ALLOWED_USER_IDS: "200",
    });
    expect(() =>
      authorizeActor(
        { chatId: "-1001", userId: "200", chatType: "supergroup" },
        config,
      ),
    ).not.toThrow();
    expect(() =>
      authorizeActor(
        { chatId: "-1001", userId: "201", chatType: "group" },
        config,
      ),
    ).toThrow();
  });

  it("permits the development override outside production only", () => {
    expect(() =>
      authorizeActor(
        actor,
        parseTelegramEnvironment({ TELEGRAM_DEV_ALLOW_UNAUTHORIZED: "true" }),
      ),
    ).not.toThrow();
    expect(() =>
      authorizeActor(
        actor,
        parseTelegramEnvironment({
          NODE_ENV: "production",
          TELEGRAM_DEV_ALLOW_UNAUTHORIZED: "true",
        }),
      ),
    ).toThrow();
  });
});
