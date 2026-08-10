import { pathToFileURL } from "node:url";

import { requireTelegramRuntimeConfig } from "./config";
import { TelegramBotApiClient } from "./telegram-client";

export async function main(arguments_: readonly string[]): Promise<void> {
  const [command, ...flags] = arguments_;
  if (!new Set(["set", "info", "delete"]).has(command ?? ""))
    throw new Error("Usage: <set|info|delete> [--confirm-delete]");
  const config = requireTelegramRuntimeConfig(process.env, "api");
  const client = new TelegramBotApiClient({
    botToken: config.TELEGRAM_BOT_TOKEN as string,
  });
  if (command === "set") {
    if (!config.TELEGRAM_WEBHOOK_URL)
      throw new Error("TELEGRAM_WEBHOOK_URL is required");
    const url = new URL(config.TELEGRAM_WEBHOOK_URL);
    if (url.protocol !== "https:")
      throw new Error("Telegram webhook URL must use HTTPS");
    const secret = config.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is required");
    await client.setWebhook(url.toString(), secret);
    console.log(JSON.stringify({ status: "configured", host: url.host }));
  } else if (command === "info") {
    const info = await client.getWebhookInfo();
    console.log(JSON.stringify({ status: "ok", webhook: info }));
  } else {
    if (!flags.includes("--confirm-delete"))
      throw new Error("Webhook deletion requires --confirm-delete");
    await client.deleteWebhook();
    console.log(JSON.stringify({ status: "deleted" }));
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
