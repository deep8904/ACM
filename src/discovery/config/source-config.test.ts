import { describe, expect, it } from "vitest";

import { parseSourceConfigText, SourceConfigError } from "./source-config";

const validSource = `
sources:
  - id: example-feed
    name: Example Feed
    type: rss
    url: https://example.com/feed.xml
    authority: primary
`;

describe("parseSourceConfigText", () => {
  it("applies bounded defaults", () => {
    const result = parseSourceConfigText(validSource);
    expect(result.sources[0]).toMatchObject({
      enabled: true,
      maxItems: 20,
      timeoutMs: 10_000,
      language: "en",
      topics: [],
    });
  });

  it("rejects duplicate source IDs with a useful error", () => {
    expect(() =>
      parseSourceConfigText(
        `${validSource}${validSource.replace("sources:", "")}`,
      ),
    ).toThrow(/Duplicate source id: example-feed/);
  });

  it("rejects invalid URLs and limits", () => {
    expect(() =>
      parseSourceConfigText(
        validSource
          .replace("https://example.com/feed.xml", "file:///feed")
          .replace(
            "authority: primary",
            "authority: primary\n    maxItems: 1000",
          ),
      ),
    ).toThrow(SourceConfigError);
  });

  it("reports malformed YAML", () => {
    expect(() => parseSourceConfigText("sources: [\n")).toThrow(
      /not valid YAML/,
    );
  });
});
