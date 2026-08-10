import { describe, expect, it } from "vitest";
import { createFinalCallbackData, parseFinalCallbackData } from "../callback";

const secret = "fixture-callback-secret-long-enough";
describe("final approval callbacks", () => {
  it("round trips a compact signed callback", () => {
    const value = createFinalCallbackData("p", "abcdef123456", 7, secret);
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(parseFinalCallbackData(value, secret)).toEqual({
      action: "p",
      shortId: "abcdef123456",
      version: 7,
    });
  });
  it("rejects tampering", () => {
    const value = createFinalCallbackData("s", "abcdef123456", 1, secret);
    expect(() =>
      parseFinalCallbackData(value.replace(":1:", ":2:"), secret),
    ).toThrow(/Invalid/);
  });
  it.each(["i", "q", "v", "t", "u"] as const)(
    "supports %s detail/revision actions",
    (action) => {
      expect(
        parseFinalCallbackData(
          createFinalCallbackData(action, "abcdef123456", 1, secret),
          secret,
        ).action,
      ).toBe(action);
    },
  );
});
