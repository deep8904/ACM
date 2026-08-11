import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { researchConfigSchema } from "./config";
import {
  ResearchRetrievalError,
  parseRetryAfter,
  retrieveSafely,
} from "./retrieve";
import { belongsToOwner, extractOfficialAlternateUrls } from "./alternates";
import { FileResearchSourceRepository } from "./storage";

const dns = async () => ["93.184.216.34"];
const base = researchConfigSchema.parse({
  maxRetrievalAttempts: 3,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 1_000,
});

describe("compliant research retrieval policy", () => {
  it("honors Retry-After before one bounded retry", async () => {
    let clock = new Date("2026-08-11T12:00:00.000Z");
    const sleep = vi.fn(async (milliseconds: number) => {
      clock = new Date(clock.getTime() + milliseconds);
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "2", "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("official", {
          headers: { "content-type": "text/plain" },
        }),
      );

    const value = await retrieveSafely(
      "https://official.example/article",
      base,
      fetcher,
      dns,
      { now: () => clock, sleep },
    );

    expect(value.body).toBe("official");
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses bounded exponential backoff with jitter when Retry-After is absent", async () => {
    let clock = new Date("2026-08-11T12:00:00.000Z");
    const delays: number[] = [];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(
        new Response("ok", { headers: { "content-type": "text/plain" } }),
      );

    await retrieveSafely(
      "https://official.example/article",
      base,
      fetcher,
      dns,
      {
        now: () => clock,
        random: () => 0,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
          clock = new Date(clock.getTime() + milliseconds);
        },
      },
    );

    expect(delays).toEqual([50, 100]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not loop on an anti-bot challenge and records a cooldown", async () => {
    const recordOutcome = vi.fn(async () => undefined);
    const fetcher = vi.fn(
      async () =>
        new Response("challenge", {
          status: 429,
          headers: { "x-vercel-mitigated": "challenge" },
        }),
    );

    await expect(
      retrieveSafely("https://official.example/article", base, fetcher, dns, {
        recordOutcome,
      }),
    ).rejects.toMatchObject({ code: "429_cooldown", status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ code: "429_cooldown" }),
    );
  });

  it("skips the network while a host cooldown is active", async () => {
    const fetcher = vi.fn();
    await expect(
      retrieveSafely("https://official.example/article", base, fetcher, dns, {
        beforeAttempt: async () => ({
          allowed: false,
          retryAt: "2026-08-11T12:30:00.000Z",
        }),
      }),
    ).rejects.toMatchObject({ code: "429_cooldown" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists one per-host budget and negative outcome across callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-policy-"));
    const repository = new FileResearchSourceRepository(root);
    const attemptedAt = "2026-08-11T12:00:00.000Z";
    const input = {
      host: "official.example",
      canonicalUrl: "https://official.example/article",
      attemptedAt,
      budget: 2,
      windowMs: 60_000,
      cooldownMs: 300_000,
    };
    expect(await repository.claimRetrievalAttempt(input)).toEqual({
      allowed: true,
    });
    expect(await repository.claimRetrievalAttempt(input)).toEqual({
      allowed: true,
    });
    expect(await repository.claimRetrievalAttempt(input)).toMatchObject({
      allowed: false,
    });

    await repository.putRetrievalOutcome({
      host: input.host,
      canonicalUrl: input.canonicalUrl,
      code: "429_cooldown",
      status: 429,
      recordedAt: attemptedAt,
      retryAt: "2026-08-11T12:30:00.000Z",
      expiresAt: "2026-08-11T12:30:00.000Z",
    });
    expect(
      await repository.getRetrievalOutcome(
        input.canonicalUrl,
        "2026-08-11T12:01:00.000Z",
      ),
    ).toMatchObject({ code: "429_cooldown" });
    expect(
      await repository.claimRetrievalAttempt({
        ...input,
        attemptedAt: "2026-08-11T12:01:00.000Z",
      }),
    ).toMatchObject({ allowed: false });
  });

  it("keeps 403 distinct and non-successful", async () => {
    await expect(
      retrieveSafely(
        "https://official.example/article",
        base,
        async () => new Response("forbidden", { status: 403 }),
        dns,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchRetrievalError>>({
        code: "403_forbidden",
        status: 403,
      }),
    );
  });

  it("parses both Retry-After forms and caps excessive delays", () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    expect(parseRetryAfter("5", now, 60_000)).toBe(5_000);
    expect(parseRetryAfter("Tue, 11 Aug 2026 12:02:00 GMT", now, 60_000)).toBe(
      60_000,
    );
  });
});

describe("official alternate representation discovery", () => {
  const target = "https://nuphy.com/blogs/journal/your-questions-answered";

  it("accepts declared canonical, AMP, and JSON-LD URLs only on the owner domain", () => {
    const values = extractOfficialAlternateUrls({
      body: `<html><head>
        <link rel="amphtml" href="/blogs/journal/your-questions-answered.amp">
        <link rel="alternate" href="https://mirror.example/your-questions-answered">
        <script type="application/ld+json">{"url":"https://help.nuphy.com/your-questions-answered"}</script>
      </head></html>`,
      contentType: "text/html",
      documentUrl: target,
      publisherOwner: "nuphy.com",
      targetUrl: target,
    });
    expect(values).toContain(
      "https://nuphy.com/blogs/journal/your-questions-answered.amp",
    );
    expect(values).toContain("https://help.nuphy.com/your-questions-answered");
    expect(values).not.toContain(
      "https://mirror.example/your-questions-answered",
    );
  });

  it("extracts matching official sitemap and RSS alternatives", () => {
    const sitemap = extractOfficialAlternateUrls({
      body: `<urlset><url><loc>https://nuphy.com/pages/your-questions-answered</loc></url><url><loc>https://nuphy.com/pages/unrelated</loc></url></urlset>`,
      contentType: "application/xml",
      documentUrl: "https://nuphy.com/sitemap.xml",
      publisherOwner: "nuphy.com",
      targetUrl: target,
    });
    const rss = extractOfficialAlternateUrls({
      body: `<rss><channel><item><link>https://nuphy.com/blogs/journal/your-questions-answered-print</link></item></channel></rss>`,
      contentType: "application/rss+xml",
      documentUrl: "https://nuphy.com/feed",
      publisherOwner: "nuphy.com",
      targetUrl: target,
    });
    expect(sitemap).toEqual([
      "https://nuphy.com/pages/your-questions-answered",
    ]);
    expect(rss).toEqual([
      "https://nuphy.com/blogs/journal/your-questions-answered-print",
    ]);
  });

  it("rejects third-party mirrors as publisher-owned", () => {
    expect(belongsToOwner("mirror.example", "nuphy.com")).toBe(false);
    expect(belongsToOwner("help.nuphy.com", "nuphy.com")).toBe(true);
  });
});
