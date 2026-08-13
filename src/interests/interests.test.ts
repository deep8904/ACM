import { describe, expect, it } from "vitest";

import { parseRankingConfig } from "../ranking/config";
import { DEFAULT_EDITORIAL_INTERESTS, editorialInterestSchema } from "./models";
import { applyEditorialInterests } from "./ranking";

describe("durable editorial interests", () => {
  it("defines the four intended V1 categories", () => {
    expect(
      DEFAULT_EDITORIAL_INTERESTS.map((interest) => interest.name),
    ).toEqual([
      "New technology / computer & design technology",
      "Product reviews / hardware",
      "Gaming / game design / game-engine news",
      "Software / AI news",
    ]);
  });

  it("adds only enabled interest keywords to ranking relevance", () => {
    const config = parseRankingConfig("{}");
    const enabled = editorialInterestSchema.parse({
      id: `interest_${"a".repeat(24)}`,
      shortId: "a".repeat(12),
      name: "Nintendo announcements",
      keywords: ["Nintendo", "Switch"],
      status: "enabled",
      isDefault: false,
      version: 1,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    const disabled = editorialInterestSchema.parse({
      ...enabled,
      id: `interest_${"b".repeat(24)}`,
      shortId: "b".repeat(12),
      name: "Disabled topic",
      keywords: ["ignore-me"],
      status: "disabled",
    });

    const result = applyEditorialInterests(config, [enabled, disabled]);

    expect(result.relevanceWeights.nintendo).toBe(4);
    expect(result.relevanceWeights.switch).toBe(4);
    expect(result.relevanceWeights["ignore-me"]).toBeUndefined();
  });
});
