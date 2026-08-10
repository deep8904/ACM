import { describe, expect, it } from "vitest";

import { InvalidUrlError, normalizeUrl } from "./normalize-url";

describe("normalizeUrl", () => {
  it("normalizes hosts, fragments, default ports, and trailing slashes", () => {
    expect(normalizeUrl("HTTPS://EXAMPLE.COM:443/path/#section")).toBe(
      "https://example.com/path",
    );
  });

  it("removes common tracking parameters case-insensitively", () => {
    expect(
      normalizeUrl(
        "https://example.com/story?UTM_Source=x&gclid=1&id=42&utm_medium=email",
      ),
    ).toBe("https://example.com/story?id=42");
  });

  it("preserves and deterministically sorts meaningful query parameters", () => {
    expect(normalizeUrl("https://example.com/search?z=2&q=feeds&z=1")).toBe(
      "https://example.com/search?q=feeds&z=1&z=2",
    );
  });

  it("retains the root slash consistently", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it.each(["not-a-url", "file:///tmp/feed.xml", "ftp://example.com/feed"])(
    "rejects invalid or unsupported URL %s",
    (value) => expect(() => normalizeUrl(value)).toThrow(InvalidUrlError),
  );
});
