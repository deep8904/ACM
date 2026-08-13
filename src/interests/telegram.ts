import { createHmac, timingSafeEqual } from "node:crypto";

import type { TelegramActor } from "../telegram/authorization";
import { TelegramControlError } from "../telegram/errors";
import type { EditorialNotificationAdapter } from "../telegram/interfaces";
import type { TelegramUpdate } from "../telegram/models";
import type { FinalReviewControl } from "../telegram/service";
import type { EditorialInterest } from "./models";
import { PostgresEditorialInterestRepository } from "./repository";

const commands = new Set([
  "/interests",
  "/interest_add",
  "/interest_enable",
  "/interest_disable",
  "/interest_remove",
]);

export class EditorialInterestTelegramController implements FinalReviewControl {
  constructor(
    private readonly deps: {
      repository: PostgresEditorialInterestRepository;
      adapter: EditorialNotificationAdapter;
      callbackSecret: string;
    },
  ) {}

  handlesCommand(command: string | undefined) {
    return Boolean(command && commands.has(command));
  }

  async processCommand(
    command: string,
    rest: string,
    update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    if (command === "/interests") {
      await this.show(actor.chatId);
      return;
    }
    if (command === "/interest_add") {
      const [name, keywordText] = rest.split("|").map((value) => value?.trim());
      if (!name || !keywordText)
        throw new TelegramControlError(
          "invalid_command",
          "Usage: /interest_add Name | keyword one, keyword two",
        );
      await this.deps.repository.add(
        name,
        keywordText.split(",").map((keyword) => keyword.trim()),
        actorInfo(actor, update),
      );
      await this.show(actor.chatId);
      return;
    }
    const reference = rest.trim();
    if (!reference)
      throw new TelegramControlError(
        "invalid_command",
        `Usage: ${command} interest_id`,
      );
    const status =
      command === "/interest_enable"
        ? "enabled"
        : command === "/interest_disable"
          ? "disabled"
          : "removed";
    await this.deps.repository.setStatus(
      reference,
      status,
      actorInfo(actor, update),
    );
    await this.show(actor.chatId);
  }

  async processCallback(update: TelegramUpdate, actor: TelegramActor) {
    const query = update.callback_query;
    if (!query?.data)
      throw new TelegramControlError(
        "stale_callback",
        "Missing interest action",
      );
    const parsed = parse(query.data, this.deps.callbackSecret);
    const status =
      parsed.action === "e"
        ? "enabled"
        : parsed.action === "d"
          ? "disabled"
          : "removed";
    await this.deps.repository.setStatus(
      parsed.shortId,
      status,
      actorInfo(actor, update),
      parsed.version,
    );
    await this.deps.adapter.answerCallback(query.id, "Interest updated");
    await this.show(actor.chatId);
  }

  async processConversationText() {
    return false;
  }

  private async show(chatId: string) {
    const interests = await this.deps.repository.list();
    if (!interests.length) {
      await this.deps.adapter.sendStatusMessage(
        chatId,
        "<b>No editorial interests</b>\nUse /interest_add Name | keyword one, keyword two.",
      );
      return;
    }
    await this.deps.adapter.sendStatusMessage(
      chatId,
      `<b>Editorial interests</b>\n${interests.length} configured. Enabled interests influence discovery ranking; changes are audited.`,
    );
    for (const interest of interests)
      await this.deps.adapter.sendFinalReviewCard(
        chatId,
        interestCard(interest, this.deps.callbackSecret),
      );
  }
}

function interestCard(interest: EditorialInterest, secret: string) {
  const toggle = interest.status === "enabled" ? "d" : "e";
  return {
    topicId: interest.id,
    text: `<b>${escape(interest.name)}</b>\nStatus: ${interest.status}\nKeywords: ${escape(interest.keywords.join(", "))}\nID: ${interest.id}`,
    buttons: [
      [
        {
          text: interest.status === "enabled" ? "Disable" : "Enable",
          callbackData: callback(toggle, interest, secret),
        },
        { text: "Remove", callbackData: callback("r", interest, secret) },
      ],
    ],
  };
}

function callback(
  action: "e" | "d" | "r",
  interest: EditorialInterest,
  secret: string,
) {
  const body = `p:${action}:${interest.shortId}:${interest.version}`;
  return `${body}:${sign(body, secret)}`;
}

function parse(data: string, secret: string) {
  const match = /^p:([edr]):([a-f0-9]{12}):(\d+):([a-f0-9]{12})$/.exec(data);
  if (!match)
    throw new TelegramControlError("stale_callback", "Invalid interest action");
  const body = data.slice(0, data.lastIndexOf(":"));
  if (!safeEqual(sign(body, secret), match[4]!))
    throw new TelegramControlError("stale_callback", "Invalid interest action");
  return {
    action: match[1] as "e" | "d" | "r",
    shortId: match[2]!,
    version: Number(match[3]),
  };
}

function sign(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("hex").slice(0, 12);
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function actorInfo(actor: TelegramActor, update: TelegramUpdate) {
  return {
    chatId: actor.chatId,
    userId: actor.userId,
    updateId: update.update_id,
  };
}

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
