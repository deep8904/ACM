import { describe, expect, it, vi } from "vitest";

import type { TelegramActor } from "../telegram/authorization";
import { RecordingTelegramAdapter } from "../telegram/recording-adapter";
import { OperationsTelegramController } from "./telegram";

const actor: TelegramActor = {
  chatId: "100",
  userId: "200",
  chatType: "private",
};

describe("Telegram automation jobs", () => {
  it("uses the actionable recovery view by default without listing history", async () => {
    const recovery = { showActionableJobs: vi.fn(async () => undefined) };
    const jobs = {
      list: vi.fn(),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    const controller = new OperationsTelegramController({
      sql: {} as never,
      adapter: new RecordingTelegramAdapter(),
      jobs: jobs as never,
      researchRecovery: recovery,
    });

    await controller.processCommand("/jobs", "", {} as never, actor);

    expect(recovery.showActionableJobs).toHaveBeenCalledWith(actor);
    expect(jobs.list).not.toHaveBeenCalled();
  });

  it("exposes immutable malformed and terminal history only in /jobs all", async () => {
    const adapter = new RecordingTelegramAdapter();
    const jobs = {
      list: vi.fn(async () => [
        {
          id: "automationjob_aaaaaaaaaaaaaaaaaaaaaaaa",
          type: "research",
          status: "blocked",
          diagnosticId: "diag_orphan",
        },
        {
          id: "automationjob_bbbbbbbbbbbbbbbbbbbbbbbb",
          type: "research",
          status: "failed",
          diagnosticId: "diag_malformed",
        },
      ]),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    const controller = new OperationsTelegramController({
      sql: {} as never,
      adapter,
      jobs: jobs as never,
    });

    await controller.processCommand("/jobs", "all", {} as never, actor);

    expect(jobs.list).toHaveBeenCalledWith(undefined, 25);
    const message = adapter.calls.find(
      (call) => call.method === "sendStatusMessage",
    );
    expect(message).toMatchObject({
      text: expect.stringContaining("Automation history"),
    });
    expect(message && "text" in message ? message.text : "").toContain(
      "diag_orphan",
    );
    expect(message && "text" in message ? message.text : "").toContain(
      "diag_malformed",
    );
    expect(jobs.retry).not.toHaveBeenCalled();
    expect(jobs.cancel).not.toHaveBeenCalled();
  });
});
