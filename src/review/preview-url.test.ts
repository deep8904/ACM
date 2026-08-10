import { describe, expect, it } from "vitest";

import {
  createRemotePreviewUrl,
  verifyRemotePreviewToken,
} from "./preview-url";
import { draftPreviewSchema } from "./models";

describe("remote preview signing", () => {
  it("creates a stable HTTPS URL and rejects tampering", () => {
    const now = Date.now();
    const preview = draftPreviewSchema.parse({
      id: `preview_${"a".repeat(24)}`,
      topicId: "topic",
      draftId: `draft_${"b".repeat(24)}`,
      draftVersion: 1,
      articleHash: "c".repeat(64),
      path: "postgres://private",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      status: "active",
    });
    const value = new URL(
      createRemotePreviewUrl(preview, {
        CONTROL_PLANE_ORIGIN: "https://control.example.com",
        PREVIEW_SIGNING_SECRET: "a sufficiently long preview secret",
      }),
    );
    expect(value.origin).toBe("https://control.example.com");
    expect(
      verifyRemotePreviewToken(
        preview.id,
        value.searchParams.get("expires")!,
        value.searchParams.get("signature")!,
        "a sufficiently long preview secret",
        now,
      ),
    ).toBe(true);
    expect(
      verifyRemotePreviewToken(
        preview.id,
        value.searchParams.get("expires")!,
        `${value.searchParams.get("signature")}x`,
        "a sufficiently long preview secret",
        now,
      ),
    ).toBe(false);
  });
});
