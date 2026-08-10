import type { TelegramActor } from "../telegram/authorization";
import { escapeTelegramHtml } from "../telegram/formatter";
import type { EditorialNotificationAdapter } from "../telegram/interfaces";
import type { FinalReviewControl } from "../telegram/service";
import type { TelegramUpdate } from "../telegram/models";
import type {
  PublicationNotificationAdapter,
  PublicationRepository,
} from "./interfaces";

export class TelegramPublicationNotifications implements PublicationNotificationAdapter {
  constructor(
    private adapter: EditorialNotificationAdapter,
    private chatId: string,
  ) {}
  private send(text: string) {
    return this.adapter
      .sendStatusMessage(this.chatId, text)
      .then(() => undefined);
  }
  started(x: {
    title: string;
    draftVersion: number;
    publicationId: string;
    scheduled: boolean;
  }) {
    return this.send(
      `<b>Publication started</b>\n${escapeTelegramHtml(x.title)}\nDraft v${x.draftVersion} · ${x.scheduled ? "scheduled" : "immediate"}\n${x.publicationId}`,
    );
  }
  committed(x: {
    publicationId: string;
    commitSha: string;
    articlePath: string;
    deploymentStatus: string;
  }) {
    return this.send(
      `<b>Commit created</b>\n${x.commitSha.slice(0, 12)} · ${escapeTelegramHtml(x.articlePath)}\nDeployment: ${escapeTelegramHtml(x.deploymentStatus)}`,
    );
  }
  published(x: {
    canonicalUrl: string;
    publishedAt: string;
    commitSha: string;
    deploymentStatus: string;
  }) {
    return this.send(
      `<b>Published</b>\n${escapeTelegramHtml(x.canonicalUrl)}\n${x.publishedAt} · ${x.commitSha.slice(0, 12)} · ${escapeTelegramHtml(x.deploymentStatus)}`,
    );
  }
  failed(x: { publicationId: string; category: string; retryable: boolean }) {
    return this.send(
      `<b>Publication failed</b>\n${x.publicationId}\nCategory: ${escapeTelegramHtml(x.category)}\nRetry available: ${x.retryable ? "yes" : "no"}`,
    );
  }
}

export class PublicationTelegramController implements FinalReviewControl {
  constructor(
    private options: {
      publications: PublicationRepository;
      adapter: EditorialNotificationAdapter;
      retryDeployment?: (topicId: string) => Promise<void>;
      verifyPublication?: (topicId: string) => Promise<void>;
    },
  ) {}
  handlesCommand(command: string | undefined) {
    return [
      "/publications",
      "/publication",
      "/retry_deployment",
      "/verify_publication",
    ].includes(command ?? "");
  }
  async processCommand(
    command: string,
    rest: string,
    _update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    if (command === "/publications") {
      const values = await this.options.publications.list();
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        values.length
          ? `<b>Publications</b>\n${values.map((x) => `${escapeTelegramHtml(x.topicId)} · ${x.status} · ${escapeTelegramHtml(x.title)}`).join("\n")}`
          : "No publications recorded.",
      );
      return;
    }
    const topicId = rest.split(/\s+/)[0];
    if (!topicId) throw new Error("A topic ID is required");
    if (command === "/retry_deployment") {
      if (!this.options.retryDeployment)
        throw new Error("Deployment retry is unavailable");
      await this.options.retryDeployment(topicId);
      return;
    }
    if (command === "/verify_publication") {
      if (this.options.verifyPublication) {
        await this.options.verifyPublication(topicId);
        return;
      }
      const publication = await this.options.publications.getByTopic(topicId);
      await this.options.adapter.sendStatusMessage(
        actor.chatId,
        publication?.status === "verification_required"
          ? `Manual verification is required for ${escapeTelegramHtml(publication.id)}. Use the private verification task and publish:verify import command.`
          : "Publication is not awaiting manual verification.",
      );
      return;
    }
    const x = await this.options.publications.getByTopic(topicId);
    await this.options.adapter.sendStatusMessage(
      actor.chatId,
      x
        ? `<b>${escapeTelegramHtml(x.title)}</b>\n${x.status} · ${x.commitSha.slice(0, 12)}\n${escapeTelegramHtml(x.canonicalUrl)}`
        : "Publication not found.",
    );
  }
  async processCallback() {
    throw new Error("Publication callbacks are not supported");
  }
  async processConversationText() {
    return false;
  }
}
