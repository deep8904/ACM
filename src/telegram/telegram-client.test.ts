import { describe, expect, it, vi } from "vitest";

import { TelegramApiError } from "./errors";
import { TelegramBotApiClient } from "./telegram-client";

describe("TelegramBotApiClient", () => {
  it("retries HTTP 429 using retry_after without logging the bot token", async () => {
    const token = "123456:SECRET_TOKEN_VALUE";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "retry",
            parameters: { retry_after: 1 },
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 5, chat: { id: 10 } },
          }),
          { status: 200 },
        ),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const records: string[] = [];
    const client = new TelegramBotApiClient({
      botToken: token,
      fetch: fetchMock,
      sleep,
      logger: (_level, message, context) =>
        records.push(JSON.stringify({ message, context })),
    });
    await expect(client.sendStatusMessage("10", "hello")).resolves.toEqual({
      chatId: "10",
      messageId: 5,
    });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(records.join(" ")).not.toContain(token);
  });

  it("translates provider failures and bounds retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 500,
          description: "failure",
        }),
        { status: 500 },
      ),
    );
    const client = new TelegramBotApiClient({
      botToken: "123456:SECRET_TOKEN_VALUE",
      fetch: fetchMock,
      maxRetries: 1,
      sleep: async () => undefined,
      logger: () => undefined,
    });
    await expect(
      client.sendStatusMessage("10", "hello"),
    ).rejects.toBeInstanceOf(TelegramApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
