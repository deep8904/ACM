import { describe, expect, it } from "vitest";

import { parseEnvironment } from "./env";

describe("parseEnvironment", () => {
  it("uses zero-cost assisted mode by default", () => {
    expect(parseEnvironment({})).toMatchObject({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      AI_MODE: "assisted",
    });
  });

  it("rejects unsupported modes and log levels", () => {
    expect(() =>
      parseEnvironment({ AI_MODE: "automatic", LOG_LEVEL: "verbose" }),
    ).toThrow();
  });

  it("treats blank future secrets as unset", () => {
    expect(
      parseEnvironment({ TELEGRAM_BOT_TOKEN: "" }).TELEGRAM_BOT_TOKEN,
    ).toBeUndefined();
  });
});
