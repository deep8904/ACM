import { describe, expect, it } from "vitest";

import { escapeTelegramHtml, formatTopicCard } from "./formatter";
import { createTelegramTestHarness, messageUpdate } from "./testing";

describe("Telegram formatting", () => {
  it("escapes Telegram HTML safely", () => {
    expect(escapeTelegramHtml('<script x="1">A & B</script>')).toBe(
      "&lt;script x=&quot;1&quot;&gt;A &amp; B&lt;/script&gt;",
    );
  });

  it("formats complete cards within Telegram limits", async () => {
    const harness = await createTelegramTestHarness();
    await harness.service.processUpdate(messageUpdate(1, "/topics"));
    const item = (await harness.repository.listQueue())[0];
    expect(item).toBeDefined();
    const card = formatTopicCard(item!, 1, harness.config.callbackSecret);
    expect(card.text.length).toBeLessThanOrEqual(4096);
    expect(card.text).toContain("Evidence:");
    expect(card.buttons.flat().map(({ text }) => text)).toEqual(
      expect.arrayContaining([
        "Approve",
        "Skip",
        "Sources",
        "Change angle",
        "Add note",
      ]),
    );
  });
});
