import { describe, expect, it, vi } from "vitest";

import { fetchTextWithPolicy } from "./http";

const basePolicy = {
  timeoutMs: 1_000,
  maxBytes: 32,
  acceptedContentTypes: ["application/xml"],
};

describe("fetchTextWithPolicy", () => {
  it("preserves a trailing slash on the initial navigation URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<rss />", {
        headers: { "content-type": "application/xml" },
      }),
    );

    const result = await fetchTextWithPolicy("https://example.com/feed/", {
      ...basePolicy,
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/feed/",
      expect.any(Object),
    );
    expect(result.finalUrl).toBe("https://example.com/feed/");
  });

  it("rejects unexpected content types", async () => {
    await expect(
      fetchTextWithPolicy("https://example.com/feed", {
        ...basePolicy,
        fetch: async () =>
          new Response("not xml", { headers: { "content-type": "text/html" } }),
      }),
    ).rejects.toThrow(/Unexpected content type/);
  });

  it("rejects oversized responses before parsing", async () => {
    await expect(
      fetchTextWithPolicy("https://example.com/feed", {
        ...basePolicy,
        fetch: async () =>
          new Response("x".repeat(64), {
            headers: { "content-type": "application/xml" },
          }),
      }),
    ).rejects.toThrow(/exceeds 32 bytes/);
  });

  it("preserves a trailing slash when following a redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/feed/" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<rss />", {
          headers: { "content-type": "application/xml" },
        }),
      );

    const result = await fetchTextWithPolicy("https://example.com/feed", {
      ...basePolicy,
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.com/feed/",
      expect.any(Object),
    );
    expect(result.finalUrl).toBe("https://example.com/feed/");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves relative redirect locations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "../final.xml" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<rss />", {
          headers: { "content-type": "application/xml" },
        }),
      );

    const result = await fetchTextWithPolicy(
      "https://example.com/feeds/current.xml",
      { ...basePolicy, fetch: fetchMock },
    );

    expect(result.finalUrl).toBe("https://example.com/final.xml");
  });

  it("preserves query strings during navigation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<rss />", {
        headers: { "content-type": "application/xml" },
      }),
    );
    const url = "https://example.com/feed/?b=2&utm_source=kept&a=1";

    const result = await fetchTextWithPolicy(url, {
      ...basePolicy,
      fetch: fetchMock,
    });

    expect(result.finalUrl).toBe(url);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.any(Object));
  });

  it("still enforces the redirect limit for loops", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "/feed" },
      }),
    );

    await expect(
      fetchTextWithPolicy("https://example.com/feed", {
        ...basePolicy,
        fetch: fetchMock,
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["file:///tmp/feed", "data:text/plain,feed", "not a URL"])(
    "rejects invalid or non-HTTP navigation URL %s",
    async (url) => {
      const fetchMock = vi.fn();
      await expect(
        fetchTextWithPolicy(url, { ...basePolicy, fetch: fetchMock }),
      ).rejects.toThrow(/Invalid HTTP\(S\) URL/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://localhost/feed",
    "http://127.0.0.1/feed",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/feed",
    "http://[::1]/feed",
  ])("blocks direct private or local navigation URL %s", async (url) => {
    const fetchMock = vi.fn();
    await expect(
      fetchTextWithPolicy(url, { ...basePolicy, fetch: fetchMock }),
    ).rejects.toThrow(/blocked private or local host/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a private-network destination", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );

    await expect(
      fetchTextWithPolicy("https://example.com/feed", {
        ...basePolicy,
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/blocked private or local host/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
