import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("hosted Telegram runtime configuration", () => {
  it("packages every YAML configuration read by the webhook function", () => {
    expect(nextConfig.outputFileTracingIncludes).toEqual({
      "/api/telegram/webhook": [
        "./automation/config/analytics.example.yaml",
        "./automation/config/publication.example.yaml",
        "./automation/config/research.example.yaml",
        "./automation/config/review.example.yaml",
        "./automation/config/social.example.yaml",
        "./automation/config/writing.example.yaml",
      ],
    });
  });
});
