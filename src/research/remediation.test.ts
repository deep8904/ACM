import { describe, expect, it, vi } from "vitest";

import type { TelegramActor } from "../telegram/authorization";
import { RecordingTelegramAdapter } from "../telegram/recording-adapter";
import type { TelegramUpdate } from "../telegram/models";
import {
  ResearchRemediationTelegramController,
  researchRemediationSchema,
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
  it("renders the blocked recovery card with only bounded research actions", async () => {
    const harness = createHarness();
    await harness.controller.notifyBlocked(blockedJob() as never, actor);
    const card = harness.adapter.calls.find(
      (call) => call.method === "sendFinalReviewCard",
    )?.card;
    expect(card?.text).toContain("Research blocked");
    expect(card?.buttons.flat().map((button) => button.text)).toEqual([
      "Add primary source",
      "Change topic",
      "Cancel",
      "Details",
    ]);
    for (const button of card?.buttons.flat() ?? [])
      expect(
        Buffer.byteLength(button.callbackData, "utf8"),
      ).toBeLessThanOrEqual(64);
  });

  it.each(["Add primary source", "Change topic", "Cancel", "Details"])(
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

  it.each([
    ["Change topic", true],
    ["Cancel", false],
  ])(
    "%s preserves lineage through cancellation semantics",
    async (label, refresh) => {
      const harness = createHarness();
      const state = await harness.repository.save(baseState());
      const callback = await blockedCallback(harness, state, label);
      await harness.controller.processCallback(callbackUpdate(callback), actor);
      expect(harness.cancelTopic).toHaveBeenCalledWith(
        state.topicId,
        expect.anything(),
        actor,
      );
      expect(harness.service.cancelJob).toHaveBeenCalledWith(
        state,
        "callback-1",
      );
      expect(harness.refreshTopics).toHaveBeenCalledTimes(refresh ? 1 : 0);
    },
  );
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
  };
  const cancelTopic = vi.fn(async () => undefined);
  const refreshTopics = vi.fn(async () => undefined);
  return {
    repository,
    adapter,
    service,
    cancelTopic,
    refreshTopics,
    controller: new ResearchRemediationTelegramController({
      service: service as never,
      repository,
      adapter,
      callbackSecret: secret,
      cancelTopic,
      refreshTopics,
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
  async audit() {}
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
