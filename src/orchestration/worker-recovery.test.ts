import { describe, expect, it } from "vitest";

import { formatAutomationRecoveryMessage } from "./worker";

describe("automation AI recovery notification", () => {
  it("creates an actionable Telegram recovery message when all providers fail", () => {
    const jobId = `automationjob_${"a".repeat(24)}`;
    const message = formatAutomationRecoveryMessage({
      jobType: "writing",
      jobId,
      diagnosticId: "diag-provider-chain",
      summary:
        "All AI providers failed: groq (groq_unavailable), openrouter (openrouter_timeout), gemini (gemini_quota_exceeded)",
    });

    expect(message).toContain("<b>writing failed</b>");
    expect(message).toContain("groq_unavailable");
    expect(message).toContain("openrouter_timeout");
    expect(message).toContain("gemini_quota_exceeded");
    expect(message).toContain(`Use /retry ${jobId}`);
    expect(message).toContain("Reference: diag-provider-chain");
  });
});
