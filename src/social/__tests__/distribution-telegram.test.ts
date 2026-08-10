import { describe, expect, it, vi } from "vitest";
import { RecordingTelegramAdapter } from "../../telegram/recording-adapter";
import type { SocialDistributionService } from "../distribution";
import { createDistributionCallback } from "../distribution-callback";
import type { SocialService } from "../service";
import { SocialTelegramController } from "../telegram";
import type { ProductionPublicationArtifactRepository } from "../../publication/interfaces";
import type { SocialConversationRepository } from "../interfaces";
import { fixtureSocialConfig as config } from "./fixture-config";

const secret = "social-callback-secret";
const plan = {
  id: "socialplan_aaaaaaaaaaaaaaaaaaaaaaaa",
  publicationId: "publication_bbbbbbbbbbbbbbbbbbbbbbbb",
  articleContentHash: "c".repeat(64),
  articleTitle: "A verified article",
  canonicalUrl: "https://deep.example/writing/verified",
  status: "selecting" as const,
  selectedPlatforms: [],
  platformStates: [],
  selectionRevision: 0,
  version: 1,
  createdAt: "2026-08-09T18:00:00.000Z",
  updatedAt: "2026-08-09T18:00:00.000Z",
};

function harness() {
  const adapter = new RecordingTelegramAdapter();
  const toggle = vi.fn(async () => ({
    ...plan,
    selectedPlatforms: ["linkedin" as const],
    platformStates: [
      {
        platform: "linkedin" as const,
        state: "selected" as const,
        provider: "manual",
        capabilities: {
          canAutoPost: false,
          supportsImages: true,
          supportsCarousel: true,
          supportsThreads: true,
          supportsDrafts: true,
        },
        itemIds: [],
        assetIds: [],
        warnings: [],
      },
    ],
    selectionRevision: 1,
    version: 2,
  }));
  const prepare = vi.fn();
  const confirm = vi.fn();
  const distribution = {
    getPlanByShortId: vi.fn(async () => plan),
    toggle,
    prepare,
    confirm,
    cancel: vi.fn(),
    status: vi.fn(),
    offer: vi.fn(async () => plan),
    capabilities: vi.fn(() => ({
      provider: "manual",
      configured: true,
      canAutoPost: false,
      supportsImages: true,
      supportsCarousel: true,
      supportsThreads: true,
      supportsDrafts: true,
    })),
    exportBundleLocation: vi.fn(
      () =>
        `postgres://content_machine/social_exports/${plan.publicationId}/v1`,
    ),
  } as unknown as SocialDistributionService;
  const controller = new SocialTelegramController({
    service: {} as SocialService,
    publications: {
      getById: vi.fn(async () => ({ id: plan.publicationId })),
      list: vi.fn(async () => []),
    } as unknown as ProductionPublicationArtifactRepository,
    adapter,
    callbackSecret: secret,
    config,
    conversations: {
      get: vi.fn(),
      save: vi.fn(),
      clear: vi.fn(),
    } as unknown as SocialConversationRepository,
    distribution,
    clock: () => new Date("2026-08-09T18:00:30.000Z"),
  });
  return { adapter, controller, distribution, toggle, prepare, confirm };
}

function update(
  data: string,
  date = Math.floor(new Date("2026-08-09T18:00:00.000Z").valueOf() / 1000),
) {
  return {
    update_id: 44,
    callback_query: {
      id: "callback-44",
      from: { id: 123, is_bot: false },
      message: {
        message_id: 90,
        date,
        chat: { id: 1, type: "private" as const },
      },
      data,
    },
  };
}

describe("Telegram distribution selection", () => {
  it("reopens the persisted selection with only the selected platforms checked", async () => {
    const h = harness();
    const selectedPlan = {
      ...plan,
      selectedPlatforms: ["linkedin" as const, "instagram" as const],
      platformStates: [],
      selectionRevision: 2,
      version: 3,
    };
    vi.mocked(h.distribution.offer).mockResolvedValue(selectedPlan);
    await h.controller.processCommand(
      "/social_status",
      plan.publicationId,
      {} as never,
      { chatId: "1", userId: "123", chatType: "private" },
    );
    const rendered = h.adapter.calls.find(
      (call) => call.method === "sendFinalReviewCard",
    );
    const labels =
      rendered && "card" in rendered
        ? rendered.card.buttons.flat().map((button) => button.text)
        : [];
    expect(labels).toEqual(
      expect.arrayContaining([
        "✓ LinkedIn",
        "□ X",
        "✓ Instagram",
        "□ Medium",
        "Prepare selected",
      ]),
    );
  });

  it("authenticates a selection callback and never prepares, approves, or posts", async () => {
    const h = harness();
    const callback = createDistributionCallback(
      "linkedin",
      plan.id.slice(-12),
      0,
      secret,
    );
    await h.controller.processCallback(update(callback) as never, {
      chatId: "1",
      userId: "123",
      chatType: "private",
    });
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(
      h.adapter.calls.some((call) => call.method === "updateFinalReviewCard"),
    ).toBe(true);
  });

  it("prepares the persisted selection at its signed revision", async () => {
    const h = harness();
    const selectedPlan = {
      ...plan,
      selectedPlatforms: ["linkedin" as const, "instagram" as const],
      selectionRevision: 2,
      version: 3,
    };
    vi.mocked(h.distribution.getPlanByShortId).mockResolvedValue(selectedPlan);
    vi.mocked(h.prepare).mockResolvedValue({
      plan: { ...selectedPlan, status: "ready_for_confirmation" as const },
    } as never);
    const callback = createDistributionCallback(
      "prepare",
      plan.id.slice(-12),
      2,
      secret,
    );
    await h.controller.processCallback(update(callback) as never, {
      chatId: "1",
      userId: "123",
      chatType: "private",
    });
    expect(h.prepare).toHaveBeenCalledWith(
      plan.id,
      2,
      expect.objectContaining({ callbackQueryId: "callback-44" }),
    );
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("rejects a tampered callback before any mutation", async () => {
    const h = harness();
    const callback = createDistributionCallback(
      "linkedin",
      plan.id.slice(-12),
      0,
      secret,
    );
    await expect(
      h.controller.processCallback(
        update(`${callback.slice(0, -1)}x`) as never,
        { chatId: "1", userId: "123", chatType: "private" },
      ),
    ).rejects.toThrow(/signature/);
    expect(h.toggle).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("accepts a freshly reopened card even when the plan itself is old", async () => {
    const h = harness();
    vi.mocked(h.distribution.getPlanByShortId).mockResolvedValue({
      ...plan,
      updatedAt: "2026-08-01T18:00:00.000Z",
    });
    const callback = createDistributionCallback(
      "linkedin",
      plan.id.slice(-12),
      0,
      secret,
    );
    await h.controller.processCallback(update(callback) as never, {
      chatId: "1",
      userId: "123",
      chatType: "private",
    });
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired distribution card before mutation", async () => {
    const h = harness();
    const callback = createDistributionCallback(
      "linkedin",
      plan.id.slice(-12),
      0,
      secret,
    );
    await expect(
      h.controller.processCallback(update(callback, 1) as never, {
        chatId: "1",
        userId: "123",
        chatType: "private",
      }),
    ).rejects.toThrow(/Expired social distribution callback/);
    expect(h.toggle).not.toHaveBeenCalled();
  });

  it("shows the exact bundle location when manual posting is ready", async () => {
    const h = harness();
    const manualReady = {
      ...plan,
      status: "manual_ready" as const,
      selectedPlatforms: ["linkedin" as const],
      platformStates: [
        {
          platform: "linkedin" as const,
          state: "manual_ready" as const,
          provider: "manual",
          capabilities: {
            canAutoPost: false,
            supportsImages: true,
            supportsCarousel: true,
            supportsThreads: true,
            supportsDrafts: true,
          },
          itemIds: [],
          assetIds: [],
          warnings: [],
        },
      ],
      packageId: "socialpackage_cccccccccccccccccccccccc",
      packageVersion: 1,
    };
    vi.mocked(h.confirm).mockResolvedValue({ plan: manualReady } as never);
    const callback = createDistributionCallback(
      "confirm",
      plan.id.slice(-12),
      0,
      secret,
    );
    await h.controller.processCallback(update(callback) as never, {
      chatId: "1",
      userId: "123",
      chatType: "private",
    });
    const rendered = h.adapter.calls.find(
      (call) => call.method === "updateFinalReviewCard",
    );
    expect(rendered && "card" in rendered ? rendered.card.text : "").toContain(
      "Ready to post manually",
    );
    expect(rendered && "card" in rendered ? rendered.card.text : "").toContain(
      `postgres://content_machine/social_exports/${plan.publicationId}/v1`,
    );
  });
});
