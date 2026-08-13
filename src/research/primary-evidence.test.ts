import { describe, expect, it } from "vitest";

import {
  hasVerifiedPrimaryEvidence,
  resolvePrimaryBlockingReasons,
} from "./primary-evidence";

describe("verified primary evidence state", () => {
  it("removes only stale primary-absence reasons for an extracted declared primary", () => {
    const packet = {
      primarySourceIds: ["source_primary"],
      sourceIndex: [
        {
          id: "source_primary",
          isPrimary: true,
          authority: "primary",
          extractionStatus: "extracted",
          selectedExcerpts: [{ id: "excerpt_1" }],
        },
      ],
    } as never;

    expect(hasVerifiedPrimaryEvidence(packet)).toBe(true);
    expect(
      resolvePrimaryBlockingReasons(packet, [
        "No primary source was retrieved",
        "Unresolved blocking conflict: price",
      ]),
    ).toEqual(["Unresolved blocking conflict: price"]);
  });

  it("keeps the gate when the declared primary has no extracted excerpt", () => {
    const packet = {
      primarySourceIds: ["source_primary"],
      sourceIndex: [
        {
          id: "source_primary",
          isPrimary: true,
          authority: "primary",
          extractionStatus: "blocked",
          selectedExcerpts: [],
        },
      ],
    } as never;

    expect(hasVerifiedPrimaryEvidence(packet)).toBe(false);
    expect(
      resolvePrimaryBlockingReasons(packet, ["A primary source is required"]),
    ).toEqual(["A primary source is required"]);
  });
});
