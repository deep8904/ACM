import { describe, expect, it } from "vitest";

import {
  isBlockedAddress,
  validateManualUrl,
  validateNavigationUrl,
} from "./safe-url";

describe("manual URL safety", () => {
  it("normalizes HTTPS URLs and removes tracking parameters without fetching", async () => {
    const lookup = async () => ["93.184.216.34"];
    await expect(
      validateManualUrl(
        "https://Example.com/story?utm_source=x&id=4#part",
        lookup,
      ),
    ).resolves.toBe("https://example.com/story?id=4");
  });

  it.each([
    "https://user:pass@example.com/story",
    "file:///tmp/story",
    "https://localhost/story",
    "http://169.254.169.254/latest/meta-data",
    "https://example.com:22/story",
    "https://[::1]/story",
    "https://[fd00::1]/story",
    "https://[fe80::1]/story",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      validateManualUrl(url, async () => ["93.184.216.34"]),
    ).rejects.toThrow();
  });

  it.each([
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "224.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("blocks private/reserved address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("rejects a public hostname when DNS resolves privately", async () => {
    await expect(
      validateManualUrl("https://example.com", async () => ["10.0.0.2"]),
    ).rejects.toThrow(/private/);
  });

  it.each([
    "192.0.66.2",
    "::ffff:192.0.66.2",
    "::ffff:c000:4202",
    "2606:50c0:8000::154",
  ])("allows public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "2001:db8::1",
  ])("continues blocking reserved or mapped-private address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("preserves navigation path and query semantics after DNS validation", async () => {
    await expect(
      validateNavigationUrl(
        "https://example.com/feed/?b=2&utm_source=kept&a=1#fragment",
        async () => ["192.0.66.2", "::ffff:192.0.66.2"],
      ),
    ).resolves.toBe("https://example.com/feed/?b=2&utm_source=kept&a=1");
  });
});
