import { describe, expect, it, vi } from "vitest";
import { RecordingTelegramAdapter } from "../../telegram/recording-adapter";
import { createSocialCallback } from "../callback";
import { SocialTelegramController } from "../telegram";
import { fixtureSocialConfig as config } from "./fixture-config";
import type { SocialService } from "../service";
import type { ProductionPublicationArtifactRepository } from "../../publication/interfaces";
import type { SocialConversationRepository } from "../interfaces";
const pkg = {
  id: "socialpackage_aaaaaaaaaaaaaaaaaaaaaaaa",
  publicationId: "publication_bbbbbbbbbbbbbbbbbbbbbbbb",
  topicId: "topic-social",
  articleTitle: "Safe article",
  canonicalUrl: "https://example.com/blog/safe",
  version: 1,
  updatedAt: "2026-08-06T12:00:00.000Z",
  items: [
    {
      id: "socialitem_cccccccccccccccccccccccc",
      platform: "linkedin",
      contentType: "linkedin_post",
      characterCount: 180,
      warnings: [],
      title: undefined,
      text: "Bounded social preview",
      thread: undefined,
      slides: undefined,
    },
  ],
};
describe("Telegram social review", () => {
  it("shows bounded cards and handles a signed idempotent approval callback", async () => {
    const adapter = new RecordingTelegramAdapter(),
      conversations = {
        get: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      } as SocialConversationRepository,
      approve = vi.fn(async () => []),
      service = {
        getPackageRecord: vi.fn(async () => pkg),
        approve,
      } as unknown as SocialService,
      publications = {
        getById: async (id: string) =>
          id === pkg.publicationId ? { id } : undefined,
        list: async () => [{ id: pkg.publicationId }],
      } as unknown as ProductionPublicationArtifactRepository,
      controller = new SocialTelegramController({
        service,
        publications,
        adapter,
        callbackSecret: "social-callback-secret",
        config,
        conversations,
        clock: () => new Date("2026-08-06T12:30:00.000Z"),
      });
    await controller.processCommand(
      "/social_package",
      pkg.publicationId,
      { update_id: 1 } as never,
      { chatId: "1", userId: "1", chatType: "private" },
    );
    expect(adapter.calls.some((x) => x.method === "sendFinalReviewCard")).toBe(
      true,
    );
    const data = createSocialCallback(
      "a",
      pkg.items[0]!.id.slice(-12),
      1,
      "social-callback-secret",
    );
    await controller.processCallback(
      {
        update_id: 2,
        callback_query: {
          id: "callback-1",
          data,
          from: { id: 1 },
          message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 },
        },
      } as never,
      { chatId: "1", userId: "1", chatType: "private" },
    );
    expect(approve).toHaveBeenCalledWith(
      pkg.publicationId,
      "linkedin",
      1,
      "approve",
      expect.objectContaining({
        itemId: pkg.items[0]!.id,
        callbackQueryId: "callback-1",
      }),
    );
    expect(JSON.stringify(adapter.calls)).not.toMatch(
      /telegramUserId|approvalNotes|article body/,
    );
    expect(approve).toHaveBeenCalledTimes(1);
  });
  it("renders a verified production package without mutating social state", async () => {
    const adapter = new RecordingTelegramAdapter(),
      getPackageRecord = vi.fn(async () => pkg),
      mutate = vi.fn(),
      conversations = {
        get: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      } as SocialConversationRepository,
      controller = new SocialTelegramController({
        service: {
          getPackageRecord,
          approve: mutate,
          markPosted: mutate,
          export: mutate,
          schedule: mutate,
        } as unknown as SocialService,
        publications: {
          getById: vi.fn(async (id: string) =>
            id === pkg.publicationId ? { id } : undefined,
          ),
          list: vi.fn(async () => []),
        } as unknown as ProductionPublicationArtifactRepository,
        adapter,
        callbackSecret: "social-callback-secret",
        config,
        conversations,
      });

    await controller.processCommand(
      "/social_package",
      pkg.publicationId,
      { update_id: 10 } as never,
      { chatId: "1", userId: "1", chatType: "private" },
    );

    expect(getPackageRecord).toHaveBeenCalledWith(pkg.publicationId);
    expect(
      adapter.calls.filter((call) => call.method === "sendFinalReviewCard"),
    ).toHaveLength(pkg.items.length);
    expect(mutate).not.toHaveBeenCalled();
    expect(conversations.save).not.toHaveBeenCalled();
    expect(conversations.clear).not.toHaveBeenCalled();
  });
  it("rejects a fixture publication identity", async () => {
    const controller = controllerForIdentityChecks();

    await expect(
      controller.processCommand(
        "/social_package",
        "publication_aaaaaaaaaaaaaaaaaaaaaaaa",
        { update_id: 11 } as never,
        { chatId: "1", userId: "1", chatType: "private" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_command",
      message: "Verified production publication not found.",
    });
  });
  it("rejects an unverified republish identity", async () => {
    const controller = controllerForIdentityChecks();

    await expect(
      controller.processCommand(
        "/social_package",
        "republish_aaaaaaaaaaaaaaaaaaaaaaaa",
        { update_id: 12 } as never,
        { chatId: "1", userId: "1", chatType: "private" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_command",
      message: "A republish ID is not a verified production publication ID.",
    });
  });
  it("sends a clear response when the verified publication has no package", async () => {
    const adapter = new RecordingTelegramAdapter(),
      controller = controllerForIdentityChecks(adapter, true);

    await controller.processCommand(
      "/social_package",
      pkg.publicationId,
      { update_id: 13 } as never,
      { chatId: "1", userId: "1", chatType: "private" },
    );

    expect(adapter.calls).toContainEqual({
      method: "sendStatusMessage",
      chatId: "1",
      text: "No social package exists for this publication.",
    });
  });
  it("rejects an expired signed callback", async () => {
    const adapter = new RecordingTelegramAdapter(),
      conversations = {
        get: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      } as SocialConversationRepository,
      service = {
        getPackageRecord: vi.fn(async () => pkg),
      } as unknown as SocialService,
      publications = {
        getById: async (id: string) =>
          id === pkg.publicationId ? { id } : undefined,
        list: async () => [{ id: pkg.publicationId }],
      } as unknown as ProductionPublicationArtifactRepository,
      controller = new SocialTelegramController({
        service,
        publications,
        adapter,
        callbackSecret: "social-callback-secret",
        config,
        conversations,
        clock: () => new Date("2026-08-06T14:00:01.000Z"),
      }),
      data = createSocialCallback(
        "a",
        pkg.items[0]!.id.slice(-12),
        1,
        "social-callback-secret",
      );
    await expect(
      controller.processCallback(
        {
          update_id: 3,
          callback_query: { id: "callback-expired", data },
        } as never,
        { chatId: "1", userId: "1", chatType: "private" },
      ),
    ).rejects.toThrow(/Expired/);
  });
});

function controllerForIdentityChecks(
  adapter = new RecordingTelegramAdapter(),
  verified = false,
) {
  return new SocialTelegramController({
    service: {
      getPackageRecord: vi.fn(async () => undefined),
    } as unknown as SocialService,
    publications: {
      getById: vi.fn(async (id: string) =>
        verified && id === pkg.publicationId ? { id } : undefined,
      ),
      list: vi.fn(async () => []),
    } as unknown as ProductionPublicationArtifactRepository,
    adapter,
    callbackSecret: "social-callback-secret",
    config,
    conversations: {
      get: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    } as SocialConversationRepository,
  });
}
