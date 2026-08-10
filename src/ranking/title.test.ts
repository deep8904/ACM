import { describe, expect, it } from "vitest";

import { normalizeStoryTitle } from "./title";

const options = {
  publisherSuffixes: ["Publication Name", "OpenAI"],
  nonSemanticPrefixes: ["breaking", "update", "official"],
};

describe("normalizeStoryTitle", () => {
  it("removes configured prefixes, safe publisher suffixes, and HTML entities", () => {
    expect(
      normalizeStoryTitle(
        "Breaking: OpenAI &amp; Microsoft release GPT-5 - Publication Name",
        options,
      ),
    ).toBe("openai microsoft release gpt-5");
  });

  it.each([
    ["GPT-5 is not delayed", "gpt-5 is not delayed"],
    ["NVIDIA RTX 5090 arrives", "nvidia rtx 5090 arrives"],
    ["Next.js 16 supports C++ and .NET", "next.js 16 supports c++ and .net"],
    ["iOS 26 — developer beta", "ios 26 - developer beta"],
    ["Café update", "café update"],
  ])("preserves technical meaning in %s", (input, expected) => {
    expect(normalizeStoryTitle(input, options)).toBe(expected);
  });

  it("does not remove an unknown suffix", () => {
    expect(normalizeStoryTitle("GPT-5 release - Unknown Blog", options)).toBe(
      "gpt-5 release - unknown blog",
    );
  });
});
