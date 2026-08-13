import { describe, expect, it, vi } from "vitest";

import type { TelegramActor } from "../telegram/authorization";
import { RecordingTelegramAdapter } from "../telegram/recording-adapter";
import type { TelegramUpdate } from "../telegram/models";
import { DurableApprovedEventError } from "./approved-event";
import { TelegramControlError } from "../telegram/errors";
import {
  ResearchRemediationService,
  ResearchRemediationInspectionError,
  ResearchRemediationTelegramController,
  researchRemediationCallbackSecret,
  researchRemediationSchema,
  shouldIssueBlockedRemediationCard,
  type ResearchRemediation,
  type ResearchRemediationRepository,
} from "./remediation";

const secret = "research-remediation-test-secret";
const actor: TelegramActor = {
  chatId: "100",
  userId: "200",
  chatType: "private",
};
const now = new Date("2026-08-11T12:00:00.000Z");

describe("Telegram research remediation", () => {
  it("creates and sends a fresh card whose Details callback is immediately valid", async () => {
    const harness = createIntegratedHarness();

    await harness.controller.notifyBlocked(recoverableJob() as never, actor);

    const callback = requiredButton(harness.adapter, "Details");
    const persisted = await harness.repository.getForActor("100", "200");
    expect(callback.split(":")[3]).toBe("1");
    expect(persisted?.version).toBe(1);

    harness.adapter.calls.length = 0;
    await harness.controller.processCallback(callbackUpdate(callback), actor);

    expect(
      harness.adapter.calls.filter((call) => call.method === "answerCallback"),
    ).toHaveLength(1);
    expect(harness.adapter.calls).toContainEqual(
      expect.objectContaining({
        method: "sendStatusMessage",
        text: expect.stringContaining("Research recovery details"),
      }),
    );
  });

  it("suppresses the same blocked transition across retry and reconciliation paths", async () => {
    const harness = createIntegratedHarness();
    let claimed = false;
    (harness.repository as ResearchRemediationRepository).claimNotification =
      vi.fn(async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      });

    await harness.controller.notifyBlocked(recoverableJob() as never, actor);
    await harness.controller.notifyBlocked(recoverableJob() as never, actor);

    expect(
      harness.adapter.calls.filter(
        (call) => call.method === "sendFinalReviewCard",
      ),
    ).toHaveLength(1);
  });

  it("keeps a known unavailable official source in the recovery card", async () => {
    const canonicalUrl =
      "https://openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows";
    const harness = createActionableHarness({
      sourceIndex: [
        {
          id: "source_aaaaaaaaaaaaaaaaaaaaaaaa",
          isPrimary: true,
          extractionStatus: "blocked",
          canonicalUrl,
          warnings: ["Retrieval failed: 403_forbidden: HTTP 403"],
        },
      ],
    });

    await harness.controller.notifyBlocked(recoverableJob() as never, actor);

    const card = harness.adapter.calls.find(
      (call) => call.method === "sendFinalReviewCard",
    )?.card;
    expect(card?.text).toContain(canonicalUrl);
    expect(card?.text).toContain("403_forbidden");
    expect(card?.buttons.flat().map((button) => button.text)).toContain(
      "Provide source evidence",
    );
    expect(card?.buttons.flat().map((button) => button.text)).not.toContain(
      "Add primary source",
    );
  });

  it("makes the old card stale on refresh while keeping the newest card valid", async () => {
    const harness = createIntegratedHarness();
    await harness.controller.notifyBlocked(recoverableJob() as never, actor);
    const oldCallback = requiredButton(harness.adapter, "Details");

    await harness.controller.notifyBlocked(recoverableJob() as never, actor);
    const newestCallback = requiredButton(harness.adapter, "Details");
    const persisted = await harness.repository.getForActor("100", "200");

    expect(oldCallback.split(":")[3]).toBe("1");
    expect(newestCallback.split(":")[3]).toBe("2");
    expect(persisted?.version).toBe(2);
    await expect(
      harness.controller.processCallback(callbackUpdate(oldCallback), actor),
    ).rejects.toThrow("This card is stale; request a new one.");
    expect(harness.logger).toHaveBeenCalledWith(
      "warn",
      "research_remediation_callback_rejected",
      expect.objectContaining({
        condition: "version_mismatch",
        version: 1,
        durableVersion: 2,
      }),
    );
    await expect(
      harness.controller.processCallback(
        callbackUpdate(newestCallback, 2, "callback-2"),
        actor,
      ),
    ).resolves.toBeUndefined();
    expect((await harness.repository.getForActor("100", "200"))?.version).toBe(
      2,
    );
  });

  it("derives the remediation signer from the shared bot identity", () => {
    const botToken = "123456789:shared-production-bot-token";
    expect(researchRemediationCallbackSecret(botToken)).toBe(
      researchRemediationCallbackSecret(botToken),
    );
    expect(researchRemediationCallbackSecret(botToken)).not.toBe(
      researchRemediationCallbackSecret(
        "987654321:different-production-bot-token",
      ),
    );
  });

  it("reissues one expired legacy card without turning scheduled runs into reminders", () => {
    const expired = researchRemediationSchema.parse({
      ...baseState(),
      expiresAt: "2026-08-11T11:59:00.000Z",
    });
    expect(shouldIssueBlockedRemediationCard(undefined, now)).toBe(true);
    expect(shouldIssueBlockedRemediationCard(expired, now)).toBe(true);
    expect(
      shouldIssueBlockedRemediationCard(
        researchRemediationSchema.parse({ ...expired, version: 2 }),
        now,
      ),
    ).toBe(false);
    expect(shouldIssueBlockedRemediationCard(baseState(), now)).toBe(false);
  });

  it("renders the blocked recovery card with only bounded research actions", async () => {
    const harness = createHarness();
    await harness.controller.notifyBlocked(blockedJob() as never, actor);
    const card = harness.adapter.calls.find(
      (call) => call.method === "sendFinalReviewCard",
    )?.card;
    expect(card?.text).toContain("Research blocked");
    expect(card?.buttons.flat().map((button) => button.text)).toEqual([
      "Add primary source",
      "Cancel approved topic…",
      "Details",
    ]);
    for (const button of card?.buttons.flat() ?? [])
      expect(
        Buffer.byteLength(button.callbackData, "utf8"),
      ).toBeLessThanOrEqual(64);
  });

  it("hides malformed and orphan history while surfacing the canonical recoverable lineage", async () => {
    const harness = createActionableHarness();

    await harness.controller.showActionableJobs(actor);

    const cards = harness.adapter.calls.filter(
      (call) => call.method === "sendFinalReviewCard",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      card: {
        topicId: baseState().topicId,
        text: expect.stringContaining("NuPhy Air75 V3"),
        buttons: [[{ text: "Resume research" }]],
      },
    });
    const callback = requiredButton(harness.adapter, "Resume research");
    expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
    expect(
      await harness.repository.getForActor(actor.chatId, actor.userId),
    ).toBeUndefined();
    expect(harness.jobs.retry).not.toHaveBeenCalled();
    expect(harness.research.extendSource).not.toHaveBeenCalled();
  });

  it("does not project the old NuPhy block while accepted packet v7 awaits synthesis", async () => {
    const harness = createActionableHarness({
      version: 7,
      status: "awaiting_assisted_synthesis",
      primarySourceIds: ["source_bbbbbbbbbbbbbbbbbbbbbbbb"],
      blockingReasons: [],
    });

    await harness.controller.showActionableJobs(actor);

    expect(
      harness.adapter.calls.filter(
        (call) => call.method === "sendFinalReviewCard",
      ),
    ).toHaveLength(0);
    expect(harness.adapter.calls).toContainEqual(
      expect.objectContaining({
        method: "sendStatusMessage",
        text: expect.stringContaining("No actionable automation jobs"),
      }),
    );
  });

  it("turns an expired card into a fresh actor-scoped recovery card through /jobs Resume", async () => {
    const harness = createActionableHarness();
    await harness.repository.save(
      researchRemediationSchema.parse({
        ...baseState(),
        expiresAt: "2026-08-11T11:59:00.000Z",
      }),
    );
    await harness.controller.showActionableJobs(actor);
    const resume = requiredButton(harness.adapter, "Resume research");
    harness.adapter.calls.length = 0;

    await harness.controller.processCallback(callbackUpdate(resume), actor);

    expect(harness.adapter.calls[0]).toMatchObject({
      method: "answerCallback",
      callbackQueryId: "callback-1",
    });
    const current = await harness.repository.getForActor("100", "200");
    expect(current?.version).toBe(2);
    expect(Date.parse(current?.expiresAt ?? "")).toBeGreaterThan(now.getTime());
    const details = requiredButton(harness.adapter, "Details");
    expect(details.split(":")[3]).toBe("2");
    await expect(
      harness.controller.processCallback(
        callbackUpdate(details, 2, "callback-2"),
        actor,
      ),
    ).resolves.toBeUndefined();
    expect(harness.adapter.calls).toContainEqual(
      expect.objectContaining({
        method: "sendStatusMessage",
        text: expect.stringContaining("Research recovery details"),
      }),
    );
    expect(harness.jobs.retry).not.toHaveBeenCalled();
    expect(harness.research.extendSource).not.toHaveBeenCalled();
  });

  it("keeps repeated Resume taps safe with one current version and stale older cards", async () => {
    const harness = createActionableHarness();
    await harness.controller.showActionableJobs(actor);
    const resume = requiredButton(harness.adapter, "Resume research");
    harness.adapter.calls.length = 0;

    await harness.controller.processCallback(callbackUpdate(resume), actor);
    const oldDetails = requiredButton(harness.adapter, "Details");
    await harness.controller.processCallback(
      callbackUpdate(resume, 2, "callback-2"),
      actor,
    );

    expect((await harness.repository.getForActor("100", "200"))?.version).toBe(
      2,
    );
    await expect(
      harness.controller.processCallback(
        callbackUpdate(oldDetails, 3, "callback-3"),
        actor,
      ),
    ).rejects.toThrow("This card is stale; request a new one.");
    expect(harness.jobs.retry).not.toHaveBeenCalled();
    expect(harness.research.extendSource).not.toHaveBeenCalled();
  });

  it("rejects a Resume button used by a different actor", async () => {
    const harness = createActionableHarness();
    await harness.controller.showActionableJobs(actor);
    const resume = requiredButton(harness.adapter, "Resume research");

    await expect(
      harness.controller.processCallback(callbackUpdate(resume), {
        ...actor,
        userId: "201",
      }),
    ).rejects.toThrow("This card is stale; request a new one.");
  });

  it.each(["Add primary source", "Cancel approved topic…", "Details"])(
    "immediately acknowledges %s before its response or side effect",
    async (label) => {
      const harness = createHarness();
      const state = await harness.repository.save(baseState());
      const callback = await blockedCallback(harness, state, label);
      harness.adapter.calls.length = 0;

      await harness.controller.processCallback(callbackUpdate(callback), actor);

      expect(harness.adapter.calls[0]).toMatchObject({
        method: "answerCallback",
        callbackQueryId: "callback-1",
      });
    },
  );

  it("keeps every blocked, input, and classification callback within Telegram's byte limit", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(baseState());
    const add = await blockedCallback(harness, state, "Add primary source");
    await harness.controller.processCallback(callbackUpdate(add), actor);
    await harness.controller.processConversationText(
      proposal().canonicalUrl,
      messageUpdate(),
      actor,
    );

    const callbackData = harness.adapter.calls.flatMap((call) =>
      "card" in call
        ? call.card.buttons.flat().map((button) => button.callbackData)
        : [],
    );
    expect(callbackData.length).toBeGreaterThan(0);
    for (const value of callbackData)
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
  });

  it("authenticates callbacks, enforces expiry, and scopes them to the actor", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(baseState());
    const callback = await blockedCallback(
      harness,
      state,
      "Add primary source",
    );
    await expect(
      harness.controller.processCallback(
        callbackUpdate(`${callback.slice(0, -1)}x`),
        actor,
      ),
    ).rejects.toThrow("This card is stale; request a new one.");
    await expect(
      harness.controller.processCallback(callbackUpdate(callback), {
        ...actor,
        userId: "201",
      }),
    ).rejects.toThrow("This card is stale; request a new one.");
    await harness.repository.save(
      researchRemediationSchema.parse({
        ...state,
        expiresAt: "2026-08-11T11:59:00.000Z",
        version: state.version + 1,
      }),
      state.version,
    );
    const expired = await blockedCallback(
      harness,
      (await harness.repository.getForActor("100", "200"))!,
      "Add primary source",
    );
    await expect(
      harness.controller.processCallback(callbackUpdate(expired), actor),
    ).rejects.toThrow("This card is stale; request a new one.");
  });

  it("keeps URL input actor-scoped and requires explicit authority confirmation", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(
      researchRemediationSchema.parse({
        ...baseState(),
        state: "awaiting_url",
      }),
    );
    await expect(
      harness.controller.processConversationText(
        "https://nuphy.com/products/air75-v3",
        messageUpdate(),
        { ...actor, userId: "201" },
      ),
    ).resolves.toBe(false);
    await expect(
      harness.controller.processConversationText(
        "https://nuphy.com/products/air75-v3",
        messageUpdate(),
        actor,
      ),
    ).resolves.toBe(true);
    expect(harness.service.inspect).toHaveBeenCalledWith(
      state,
      "https://nuphy.com/products/air75-v3",
    );
    const latest = harness.adapter.calls.at(-1);
    const card = latest && "card" in latest ? latest.card : undefined;
    expect(card?.text).toContain("Proposed authority: primary");
    expect(card?.buttons.flat().map((button) => button.text)).toEqual([
      "Confirm primary",
      "Treat as independent",
      "Cancel",
    ]);
  });

  it("turns a 429 into signed recovery actions without adding a source", async () => {
    const harness = createHarness();
    await harness.repository.save(awaitingUrlState());
    harness.service.inspect.mockRejectedValueOnce(
      new ResearchRemediationInspectionError(
        "Rate limited. Reference: diag_a4976f04b106b3e8",
        "429_cooldown",
        "diag_a4976f04b106b3e8",
        "2026-08-11T12:15:00.000Z",
      ),
    );

    await expect(
      harness.controller.processConversationText(
        "https://nuphy.com/blogs/journal/your-questions-answered",
        messageUpdate(),
        actor,
      ),
    ).resolves.toBe(true);

    const card = harness.adapter.calls.findLast(
      (call) => call.method === "sendFinalReviewCard",
    )?.card;
    expect(card?.text).toContain("429_cooldown");
    expect(card?.buttons.flat().map((button) => button.text)).toEqual([
      "Provide source evidence",
      "Retry later",
      "Find another official source",
      "Paste another URL",
      "Cancel source attempt",
    ]);
    expect(harness.service.confirm).not.toHaveBeenCalled();
  });

  it("schedules Retry later once and rejects callback replay", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(
      researchRemediationSchema.parse({
        ...baseState(),
        pendingUrl: "https://nuphy.com/blogs/journal/your-questions-answered",
        retrievalFailure: {
          code: "429_cooldown",
          diagnosticId: "diag_a4976f04b106b3e8",
          retryAt: "2026-08-11T12:15:00.000Z",
        },
      }),
    );
    harness.service.openBlocked.mockResolvedValueOnce(state);
    await harness.controller.notifyBlocked(blockedJob() as never, actor);
    harness.service.inspect.mockRejectedValueOnce(
      new ResearchRemediationInspectionError(
        "Rate limited",
        "429_cooldown",
        "diag_a4976f04b106b3e8",
        "2026-08-11T12:15:00.000Z",
      ),
    );
    await harness.repository.save(
      researchRemediationSchema.parse({ ...state, state: "awaiting_url" }),
      state.version,
    );
    await harness.controller.processConversationText(
      "https://nuphy.com/blogs/journal/your-questions-answered",
      messageUpdate(),
      actor,
    );
    const retry = requiredButton(harness.adapter, "Retry later");

    await harness.controller.processCallback(callbackUpdate(retry), actor);
    await expect(
      harness.controller.processCallback(
        callbackUpdate(retry, 2, "retry-replay"),
        actor,
      ),
    ).rejects.toThrow(/stale/);
    expect(harness.service.scheduleRetry).toHaveBeenCalledTimes(1);
  });

  it("collects actor-scoped text, confirms provenance, and accepts evidence once", async () => {
    const harness = createHarness();
    await harness.repository.save(
      researchRemediationSchema.parse({
        ...baseState(),
        pendingUrl: "https://nuphy.com/blogs/journal/your-questions-answered",
        retrievalFailure: {
          code: "429_cooldown",
          diagnosticId: "diag_a4976f04b106b3e8",
        },
      }),
    );
    harness.service.openBlocked.mockResolvedValueOnce(
      (await harness.repository.getForActor("100", "200"))!,
    );
    await harness.controller.notifyBlocked(blockedJob() as never, actor);
    const provide = requiredButton(harness.adapter, "Provide source evidence");

    await harness.controller.processCallback(callbackUpdate(provide), actor);
    expect((await harness.repository.getForActor("100", "200"))?.state).toBe(
      "awaiting_evidence",
    );
    await expect(
      harness.controller.processConversationText(
        "This evidence belongs to someone else and must not be consumed.",
        messageUpdate(),
        { ...actor, userId: "201" },
      ),
    ).resolves.toBe(false);
    await expect(
      harness.controller.processConversationText("   ", messageUpdate(), actor),
    ).rejects.toThrow(/cannot be blank/);
    const evidence =
      "NuPhy states that the product supports several connection modes and includes configurable features for customers. The official page answers common questions and explains what is included, how the device works, and which options are supported.";
    await harness.controller.processConversationText(
      evidence,
      messageUpdate(),
      actor,
    );
    const review = requiredButton(harness.adapter, "Review evidence");
    await harness.controller.processCallback(
      callbackUpdate(review, 2, "review-evidence"),
      actor,
    );
    const confirm = requiredButton(harness.adapter, "Confirm provenance");
    await harness.controller.processCallback(
      callbackUpdate(confirm, 3, "confirm-evidence"),
      actor,
    );
    await harness.controller.processCallback(
      callbackUpdate(confirm, 4, "confirm-evidence-replay"),
      actor,
    );

    expect(harness.service.acceptEvidence).toHaveBeenCalledTimes(1);
    expect((await harness.repository.getForActor("100", "200"))?.state).toBe(
      "queued",
    );
    expect(harness.cancelTopic).not.toHaveBeenCalled();
  });

  it("rejects a third-party URL before entering evidence collection", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(
      researchRemediationSchema.parse({
        ...baseState(),
        pendingUrl: "https://example.com/nuphy-report",
        retrievalFailure: {
          code: "403_forbidden",
          diagnosticId: "diag_a4976f04b106b3e8",
        },
      }),
    );
    harness.service.openBlocked.mockResolvedValueOnce(state);
    harness.service.verifyEvidencePath.mockRejectedValueOnce(
      new TelegramControlError(
        "invalid_url",
        "verified official publisher URL required",
        400,
      ),
    );
    await harness.controller.notifyBlocked(blockedJob() as never, actor);
    const provide = requiredButton(harness.adapter, "Provide source evidence");

    await expect(
      harness.controller.processCallback(callbackUpdate(provide), actor),
    ).rejects.toThrow(/official publisher URL/);
    expect((await harness.repository.getForActor("100", "200"))?.state).toBe(
      "blocked",
    );
  });

  it("cancels evidence entry without cancelling the topic or job", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(
      researchRemediationSchema.parse({
        ...baseState(),
        pendingUrl: "https://nuphy.com/blogs/journal/your-questions-answered",
        retrievalFailure: {
          code: "429_cooldown",
          diagnosticId: "diag_a4976f04b106b3e8",
        },
      }),
    );
    harness.service.openBlocked.mockResolvedValueOnce(state);
    await harness.controller.notifyBlocked(blockedJob() as never, actor);
    await harness.controller.processCallback(
      callbackUpdate(
        requiredButton(harness.adapter, "Provide source evidence"),
      ),
      actor,
    );
    await harness.controller.processConversationText(
      "A relevant official excerpt is supplied for review and it includes enough detail to remain useful while testing cancellation behavior safely.",
      messageUpdate(),
      actor,
    );
    const cancel = requiredButton(harness.adapter, "Cancel evidence entry");
    await harness.controller.processCallback(
      callbackUpdate(cancel, 2, "cancel-evidence"),
      actor,
    );

    expect(await harness.repository.getForActor("100", "200")).toMatchObject({
      state: "blocked",
      evidenceChunks: undefined,
      pendingUrl: "https://nuphy.com/blogs/journal/your-questions-answered",
    });
    expect(harness.cancelTopic).not.toHaveBeenCalled();
    expect(harness.service.cancelJob).not.toHaveBeenCalled();
  });

  it.each([
    ["Find another official source", "find"],
    ["Paste another URL", "paste"],
    ["Cancel source attempt", "cancel"],
  ] as const)("handles the 429 recovery action %s", async (label, action) => {
    const harness = createHarness();
    await harness.repository.save(awaitingUrlState());
    harness.service.inspect.mockRejectedValueOnce(
      new ResearchRemediationInspectionError(
        "Rate limited",
        "429_cooldown",
        "diag_a4976f04b106b3e8",
        "2026-08-11T12:15:00.000Z",
      ),
    );
    await harness.controller.processConversationText(
      "https://nuphy.com/blogs/journal/your-questions-answered",
      messageUpdate(),
      actor,
    );
    const callback = requiredButton(harness.adapter, label);

    await harness.controller.processCallback(callbackUpdate(callback), actor);

    const current = await harness.repository.getForActor("100", "200");
    if (action === "find") {
      expect(harness.service.findOfficialAlternatives).toHaveBeenCalledTimes(1);
      expect(current?.state).toBe("blocked");
    } else if (action === "paste") {
      expect(current).toMatchObject({
        state: "awaiting_url",
        pendingUrl: undefined,
        retrievalFailure: undefined,
      });
    } else {
      expect(current).toMatchObject({
        state: "blocked",
        pendingUrl: undefined,
        retrievalFailure: undefined,
      });
      expect(harness.cancelTopic).not.toHaveBeenCalled();
    }
  });

  it("consumes one URL and leaves a deterministic non-consuming result for a second URL", async () => {
    const harness = createHarness();
    await harness.repository.save(awaitingUrlState());

    await expect(
      harness.controller.processConversationText(
        "https://hacdias.com/nuphy-review",
        messageUpdate(),
        actor,
      ),
    ).resolves.toBe(true);
    await expect(
      harness.controller.processConversationText(
        "https://nuphy.com/official",
        messageUpdate(),
        actor,
      ),
    ).resolves.toBe(false);
    expect(harness.service.inspect).toHaveBeenCalledTimes(1);
    expect((await harness.repository.getForActor("100", "200"))?.state).toBe(
      "awaiting_classification",
    );
  });

  it("keeps the URL request active and reports a redacted diagnostic for unexpected inspection failures", async () => {
    const harness = createHarness();
    const audit = vi.spyOn(harness.repository, "audit");
    await harness.repository.save(awaitingUrlState());
    harness.service.inspect.mockRejectedValueOnce(
      new Error(
        "fetch failed https://example.com/path?token=secret-value actor 123456789",
      ),
    );

    await expect(
      harness.controller.processConversationText(
        "https://example.com/path?token=secret-value",
        messageUpdate(),
        actor,
      ),
    ).rejects.toMatchObject({
      code: "invalid_url",
      message: expect.stringMatching(/request is still active.*Reference:/),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "source_inspection_failed",
        details: { category: "internal", errorName: "Error" },
      }),
    );
    const diagnostic = harness.logger.mock.calls.find(
      ([, message]) => message === "research_remediation_continuation_failed",
    )?.[2];
    expect(diagnostic?.error).toContain("[REDACTED_URL]");
    expect(diagnostic?.error).not.toContain("secret-value");
    expect(diagnostic?.error).not.toContain("123456789");
    expect((await harness.repository.getForActor("100", "200"))?.state).toBe(
      "awaiting_url",
    );
  });

  it("preserves expected expired-state errors for the Telegram boundary", async () => {
    const harness = createHarness();
    await harness.repository.save(awaitingUrlState());
    harness.service.inspect.mockRejectedValueOnce(
      new TelegramControlError(
        "stale_callback",
        "This research recovery request expired. Open it again from /jobs.",
        409,
      ),
    );

    await expect(
      harness.controller.processConversationText(
        "https://nuphy.com/official",
        messageUpdate(),
        actor,
      ),
    ).rejects.toMatchObject({ code: "stale_callback" });
    expect(harness.logger).not.toHaveBeenCalledWith(
      "warn",
      "research_remediation_continuation_failed",
      expect.anything(),
    );
  });

  it("confirms once, creates the next packet through the service, and rejects replay", async () => {
    const harness = createHarness();
    await harness.repository.save(awaitingUrlState());
    const { callback, state } = await classificationCallback(
      harness,
      "Confirm primary",
    );
    await harness.controller.processCallback(callbackUpdate(callback), actor);
    expect(harness.service.confirm).toHaveBeenCalledTimes(1);
    expect(harness.service.confirm).toHaveBeenCalledWith(
      state,
      "primary",
      "callback-1",
    );
    expect((await harness.repository.getForActor("100", "200"))?.state).toBe(
      "queued",
    );
    await expect(
      harness.controller.processCallback(
        callbackUpdate(callback, 2, "callback-2"),
        actor,
      ),
    ).rejects.toThrow("This card is stale; request a new one.");
    expect(harness.service.confirm).toHaveBeenCalledTimes(1);
  });

  it("never auto-escalates the independent choice", async () => {
    const harness = createHarness();
    await harness.repository.save(awaitingUrlState());
    const { callback, state } = await classificationCallback(
      harness,
      "Treat as independent",
    );
    await harness.controller.processCallback(callbackUpdate(callback), actor);
    expect(harness.service.confirm).toHaveBeenCalledWith(
      state,
      "independent",
      "callback-1",
    );
  });

  it("cancels only source entry while waiting for a URL", async () => {
    const harness = createHarness();
    const audit = vi.spyOn(harness.repository, "audit");
    const state = await harness.repository.save(baseState());
    const add = await blockedCallback(harness, state, "Add primary source");
    await harness.controller.processCallback(callbackUpdate(add), actor);
    const cancel = requiredButton(harness.adapter, "Cancel");

    await harness.controller.processCallback(
      callbackUpdate(cancel, 2, "cancel-url"),
      actor,
    );

    const current = await harness.repository.getForActor("100", "200");
    expect(current).toMatchObject({ state: "blocked", proposal: undefined });
    expect(harness.cancelTopic).not.toHaveBeenCalled();
    expect(harness.service.cancelJob).not.toHaveBeenCalled();
    expect(harness.service.confirm).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "interaction_cancelled",
        details: { fromState: "awaiting_url" },
      }),
    );
    expect(requiredButton(harness.adapter, "Add primary source")).toBeTruthy();
  });

  it("keeps the approved blocked topic actionable after source-entry cancellation", async () => {
    const harness = createActionableHarness();
    await harness.controller.notifyBlocked(recoverableJob() as never, actor);
    const add = requiredButton(harness.adapter, "Add primary source");
    await harness.controller.processCallback(callbackUpdate(add), actor);
    const cancel = requiredButton(harness.adapter, "Cancel");

    await harness.controller.processCallback(callbackUpdate(cancel), actor);
    harness.adapter.calls.length = 0;
    await harness.controller.showActionableJobs(actor);

    expect(requiredButton(harness.adapter, "Resume research")).toBeTruthy();
    expect(harness.jobs.retry).not.toHaveBeenCalled();
    expect(harness.research.extendSource).not.toHaveBeenCalled();
  });

  it("cancels only classification after an independent-source proposal", async () => {
    const harness = createHarness();
    await harness.repository.save(awaitingUrlState());
    harness.service.inspect.mockResolvedValueOnce({
      ...proposal(),
      canonicalUrl: "https://hacdias.com/nuphy-review",
      publisher: "Hacdias",
      publisherOwner: "hacdias.com",
      proposedAuthority: "independent",
      reason: "The publisher is independent from the topic owner.",
    } as never);
    await harness.controller.processConversationText(
      "https://hacdias.com/nuphy-review",
      messageUpdate(),
      actor,
    );
    const cancel = requiredButton(harness.adapter, "Cancel");

    await harness.controller.processCallback(
      callbackUpdate(cancel, 2, "cancel-classification"),
      actor,
    );

    const current = await harness.repository.getForActor("100", "200");
    expect(current).toMatchObject({ state: "blocked", proposal: undefined });
    expect(harness.service.confirm).not.toHaveBeenCalled();
    expect(harness.cancelTopic).not.toHaveBeenCalled();
    expect(harness.service.cancelJob).not.toHaveBeenCalled();
  });

  it("makes replayed remediation Cancel callbacks idempotent", async () => {
    const harness = createHarness();
    const audit = vi.spyOn(harness.repository, "audit");
    await harness.repository.save(awaitingUrlState());
    const { callback } = await classificationCallback(harness, "Cancel");

    await harness.controller.processCallback(callbackUpdate(callback), actor);
    const version = (
      await harness.repository.getForActor(actor.chatId, actor.userId)
    )?.version;
    await expect(
      harness.controller.processCallback(
        callbackUpdate(callback, 2, "cancel-replay"),
        actor,
      ),
    ).resolves.toBeUndefined();

    expect(
      (await harness.repository.getForActor(actor.chatId, actor.userId))
        ?.version,
    ).toBe(version);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(harness.service.confirm).not.toHaveBeenCalled();
    expect(harness.cancelTopic).not.toHaveBeenCalled();
    expect(harness.service.cancelJob).not.toHaveBeenCalled();
  });

  it("keeps topic-level cancellation separate and explicitly confirmed", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(baseState());
    const request = await blockedCallback(
      harness,
      state,
      "Cancel approved topic…",
    );

    await harness.controller.processCallback(callbackUpdate(request), actor);
    expect(harness.cancelTopic).not.toHaveBeenCalled();
    expect(harness.service.cancelJob).not.toHaveBeenCalled();
    const confirmation = requiredButton(
      harness.adapter,
      "Confirm topic cancellation",
    );

    await harness.controller.processCallback(
      callbackUpdate(confirmation, 2, "confirm-topic-cancel"),
      actor,
    );
    expect(harness.cancelTopic).toHaveBeenCalledWith(
      state.topicId,
      expect.anything(),
      actor,
    );
    expect(harness.service.cancelJob).toHaveBeenCalledTimes(1);
    expect(harness.refreshTopics).toHaveBeenCalledTimes(1);
  });

  it("returns from topic cancellation confirmation without cancelling", async () => {
    const harness = createHarness();
    const state = await harness.repository.save(baseState());
    const request = await blockedCallback(
      harness,
      state,
      "Cancel approved topic…",
    );
    await harness.controller.processCallback(callbackUpdate(request), actor);
    const keep = requiredButton(harness.adapter, "Keep topic");

    await harness.controller.processCallback(
      callbackUpdate(keep, 2, "keep-topic"),
      actor,
    );

    expect(harness.cancelTopic).not.toHaveBeenCalled();
    expect(harness.service.cancelJob).not.toHaveBeenCalled();
    expect(
      (await harness.repository.getForActor(actor.chatId, actor.userId))?.state,
    ).toBe("blocked");
    expect(requiredButton(harness.adapter, "Add primary source")).toBeTruthy();
  });
});

function createHarness() {
  const repository = new MemoryRepository();
  const adapter = new RecordingTelegramAdapter();
  const service = {
    openBlocked: vi.fn(async () => baseState()),
    openTopic: vi.fn(async () => baseState()),
    inspect: vi.fn(async () => proposal()),
    confirm: vi.fn(async () => ({
      packet: { version: 7 },
      job: { id: "automationjob_bbbbbbbbbbbbbbbbbbbbbbbb" },
    })),
    cancelJob: vi.fn(async () => undefined),
    scheduleRetry: vi.fn(async () => ({
      availableAt: "2026-08-11T12:15:00.000Z",
    })),
    findOfficialAlternatives: vi.fn(async () => []),
    verifyEvidencePath: vi.fn(async () => ({
      canonicalUrl: "https://nuphy.com/blogs/journal/your-questions-answered",
    })),
    acceptEvidence: vi.fn(async () => ({
      packet: { version: 7 },
      job: { id: "automationjob_bbbbbbbbbbbbbbbbbbbbbbbb" },
      provenance: {
        evidenceRecordId: "evidence_bbbbbbbbbbbbbbbbbbbbbbbb",
        evidenceHash: "b".repeat(64),
      },
    })),
    ensureEvidenceContinuation: vi.fn(async () => undefined),
  };
  const cancelTopic = vi.fn(async () => undefined);
  const refreshTopics = vi.fn(async () => undefined);
  const logger = vi.fn();
  return {
    repository,
    adapter,
    service,
    cancelTopic,
    refreshTopics,
    logger,
    controller: new ResearchRemediationTelegramController({
      service: service as never,
      repository,
      adapter,
      callbackSecret: secret,
      cancelTopic,
      refreshTopics,
      now: () => now,
      logger,
    }),
  };
}

function createIntegratedHarness() {
  const repository = new MemoryRepository();
  const adapter = new RecordingTelegramAdapter();
  const packet = {
    topicId: baseState().topicId,
    approvedEventId: baseState().eventId,
    version: 6,
    sufficient: false,
    blockingReasons: ["No primary source was retrieved"],
  };
  const event = { id: baseState().eventId, topicId: baseState().topicId };
  const queue = {
    approvalStatus: "approved",
    researchReadiness: "awaiting_source",
  };
  const service = new ResearchRemediationService({
    remediation: repository,
    research: {} as never,
    packets: { get: vi.fn(async () => packet) } as never,
    events: {
      get: vi.fn(async () => event),
      queue: vi.fn(async () => queue),
      isConsumed: vi.fn(async () => true),
    } as never,
    topics: { getQueueItem: vi.fn(async () => queue) } as never,
    jobs: {} as never,
    now: () => now,
  });
  const logger = vi.fn();
  return {
    repository,
    adapter,
    logger,
    controller: new ResearchRemediationTelegramController({
      service,
      repository,
      adapter,
      callbackSecret: secret,
      cancelTopic: vi.fn(async () => undefined),
      refreshTopics: vi.fn(async () => undefined),
      now: () => now,
      logger,
    }),
  };
}

function createActionableHarness(
  packetOverrides: Record<string, unknown> = {},
) {
  const repository = new MemoryRepository();
  const adapter = new RecordingTelegramAdapter();
  const current = recoverableJob();
  const malformed = {
    ...current,
    id: "automationjob_aaaaaaaaaaaaaaaaaaaaaaaa",
    payload: {},
  };
  const orphanEventId = "event_bbbbbbbbbbbbbbbbbbbbbbbb";
  const orphan = {
    ...current,
    id: "automationjob_cccccccccccccccccccccccc",
    lineageKey: orphanEventId,
    payload: { eventId: orphanEventId },
  };
  const invalidDurableEventId = "event_6296784279ae12c54771daf8";
  const invalidDurable = {
    ...current,
    id: "automationjob_eeeeeeeeeeeeeeeeeeeeeeee",
    lineageKey: invalidDurableEventId,
    payload: { eventId: invalidDurableEventId },
  };
  const olderCanonical = {
    ...current,
    id: "automationjob_dddddddddddddddddddddddd",
  };
  const packet = {
    topicId: baseState().topicId,
    approvedEventId: baseState().eventId,
    version: 6,
    sufficient: false,
    blockingReasons: ["No primary source was retrieved"],
    ...packetOverrides,
  };
  const queue = {
    approvalStatus: "approved",
    researchReadiness: "awaiting_source",
    candidateSnapshot: {
      candidate: { title: "NuPhy Air75 V3" },
    },
  };
  const jobs = {
    list: vi.fn(async () => [
      malformed,
      orphan,
      invalidDurable,
      current,
      olderCanonical,
    ]),
    get: vi.fn(async (id: string) => (id === current.id ? current : undefined)),
    retry: vi.fn(),
  };
  const research = { extendSource: vi.fn() };
  const service = new ResearchRemediationService({
    remediation: repository,
    research: research as never,
    packets: { get: vi.fn(async () => packet) } as never,
    events: {
      get: vi.fn(async (id: string) => {
        if (id === invalidDurableEventId)
          throw new DurableApprovedEventError(
            `Invalid durable approved-topic event ${id}`,
          );
        return id === baseState().eventId
          ? { id, topicId: baseState().topicId }
          : undefined;
      }),
      queue: vi.fn(async () => queue),
      isConsumed: vi.fn(async () => true),
    } as never,
    topics: {
      getQueueItem: vi.fn(async () => queue),
      saveQueueItem: vi.fn(),
    } as never,
    jobs: jobs as never,
    now: () => now,
  });
  return {
    repository,
    adapter,
    jobs,
    research,
    controller: new ResearchRemediationTelegramController({
      service,
      repository,
      adapter,
      callbackSecret: secret,
      cancelTopic: vi.fn(async () => undefined),
      refreshTopics: vi.fn(async () => undefined),
      now: () => now,
    }),
  };
}

class MemoryRepository implements ResearchRemediationRepository {
  private value?: ResearchRemediation;
  async getByShortId(shortId: string) {
    return this.value?.shortId === shortId ? this.value : undefined;
  }
  async getForActor(chatId: string, userId: string) {
    return this.value?.chatId === chatId && this.value.userId === userId
      ? this.value
      : undefined;
  }
  async getForJobActor(jobId: string, chatId: string, userId: string) {
    return this.value?.jobId === jobId &&
      this.value.chatId === chatId &&
      this.value.userId === userId
      ? this.value
      : undefined;
  }
  async save(value: ResearchRemediation, expectedVersion?: number) {
    if (
      expectedVersion !== undefined &&
      this.value?.version !== expectedVersion
    )
      throw new Error("version conflict");
    this.value = researchRemediationSchema.parse(value);
    return this.value;
  }
  async cancelInteraction(
    value: ResearchRemediation,
    expectedVersion: number,
    dedupeKey: string,
    fromState: ResearchRemediation["state"],
  ) {
    const saved = await this.save(value, expectedVersion);
    await this.audit({
      remediationId: value.id,
      topicId: value.topicId,
      jobId: value.jobId,
      action: "interaction_cancelled",
      dedupeKey,
      details: { fromState },
    });
    return saved;
  }
  async audit(input: Parameters<ResearchRemediationRepository["audit"]>[0]) {
    void input;
  }
}

async function blockedCallback(
  harness: ReturnType<typeof createHarness>,
  state: ResearchRemediation,
  label: string,
) {
  harness.service.openBlocked.mockResolvedValueOnce(state);
  await harness.controller.notifyBlocked(blockedJob() as never, actor);
  return requiredButton(harness.adapter, label);
}

async function classificationCallback(
  harness: ReturnType<typeof createHarness>,
  label: string,
) {
  harness.service.inspect.mockResolvedValueOnce(proposal());
  await harness.controller.processConversationText(
    proposal().canonicalUrl,
    messageUpdate(),
    actor,
  );
  return {
    callback: requiredButton(harness.adapter, label),
    state: (await harness.repository.getForActor("100", "200"))!,
  };
}

function requiredButton(adapter: RecordingTelegramAdapter, label: string) {
  const button = adapter.calls
    .flatMap((call) => ("card" in call ? call.card.buttons.flat() : []))
    .findLast((candidate) => candidate.text === label);
  if (!button) throw new Error(`Missing ${label} button`);
  return button.callbackData;
}

function baseState() {
  return researchRemediationSchema.parse({
    id: "remediation_aaaaaaaaaaaaaaaaaaaaaaaa",
    shortId: "aaaaaaaaaaaa",
    chatId: actor.chatId,
    userId: actor.userId,
    topicId: "topic_manual_4c603d43de72f01e1821878c",
    eventId: "event_509d1ba7456cbe4e7d149952",
    jobId: "automationjob_062356977f80a1ee382f965d",
    packetVersion: 6,
    state: "blocked",
    reason: "No primary source was retrieved",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: "2026-08-11T12:30:00.000Z",
    version: 1,
  });
}

function awaitingUrlState() {
  return researchRemediationSchema.parse({
    ...baseState(),
    state: "awaiting_url",
  });
}

function proposal() {
  return {
    canonicalUrl: "https://nuphy.com/products/air75-v3",
    title: "NuPhy Air75 V3",
    publisher: "Nuphy",
    publisherOwner: "nuphy.com",
    sourceType: "product_page" as const,
    proposedAuthority: "primary" as const,
    reason: "The publisher domain matches the approved topic identity.",
    contentHash: "a".repeat(64),
  };
}

function blockedJob() {
  return {
    id: "automationjob_062356977f80a1ee382f965d",
    type: "research",
    status: "blocked",
  };
}

function recoverableJob() {
  return {
    ...blockedJob(),
    topicId: baseState().topicId,
    lineageKey: baseState().eventId,
    payload: { eventId: baseState().eventId },
  };
}

function callbackUpdate(
  data: string,
  updateId = 1,
  callbackId = "callback-1",
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: 200, is_bot: false },
      message: {
        message_id: 10,
        date: 1,
        chat: { id: 100, type: "private" },
      },
      data,
    },
  };
}

function messageUpdate(): TelegramUpdate {
  return {
    update_id: 3,
    message: {
      message_id: 11,
      date: 1,
      chat: { id: 100, type: "private" },
      from: { id: 200, is_bot: false },
      text: "source",
    },
  };
}
