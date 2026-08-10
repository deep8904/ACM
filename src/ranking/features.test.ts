import { describe, expect, it } from "vitest";

import { rankingConfigSchema } from "./config";
import { extractFeatures } from "./features";

const config = rankingConfigSchema.parse({
  stopWords: ["the", "for", "and", "is"],
  eventKeywords: ["release", "update"],
  rumorPatterns: ["reportedly", "unconfirmed"],
  entityRules: [
    { canonical: "OpenAI", type: "organization", aliases: ["OpenAI"] },
    { canonical: "GPT-5 API", type: "product", aliases: ["GPT-5 API"] },
    { canonical: "C++", type: "language", aliases: ["C++"] },
  ],
});

describe("extractFeatures", () => {
  it("weights title terms, removes stop words, and preserves product identifiers", () => {
    const features = extractFeatures(
      "OpenAI releases GPT-5 API for C++ developers",
      "The GPT-5 API release is for developer workflows and API tools.",
      config,
    );
    expect(features.keywords.slice(0, 3)).toContain("gpt-5 api");
    expect(features.keywords).not.toContain("the");
    expect(features.entities).toEqual(["C++", "GPT-5 API", "OpenAI"]);
    expect(features.productIdentifiers).toContain("GPT-5 API");
    expect(features.eventKeywords).toEqual(["release"]);
  });

  it("deduplicates rumor and keyword terms", () => {
    const features = extractFeatures(
      "GPT-5 reportedly update update",
      "An unconfirmed update was reportedly discussed.",
      config,
    );
    expect(new Set(features.keywords).size).toBe(features.keywords.length);
    expect(features.rumorMatches).toEqual(["reportedly", "unconfirmed"]);
  });

  it("avoids substring entity false positives", () => {
    expect(
      extractFeatures("An open air design", "", config).entities,
    ).not.toContain("OpenAI");
  });
});
