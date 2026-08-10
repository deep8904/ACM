import { describe, expect, it } from "vitest";

import { createCallbackData, parseCallbackData } from "./callback";

const secret = "callback-secret-at-least-16";

describe("signed callback data", () => {
  it("round trips within Telegram's 64-byte limit", () => {
    const value = createCallbackData("a", "abcdef123456", 12, secret);
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(parseCallbackData(value, secret)).toEqual({
      action: "a",
      shortId: "abcdef123456",
      version: 12,
    });
  });

  it.each([
    "t:a:abcdef123456:1:tamperedxx",
    "t:x:abcdef123456:1:abcdefghij",
    "topic title and secret URL",
  ])("rejects malformed or tampered callback %s", (value) => {
    expect(() => parseCallbackData(value, secret)).toThrow(
      /Invalid or outdated/,
    );
  });
});
