import type { TelegramActor } from "../telegram/authorization";
import { TelegramControlError } from "../telegram/errors";
import type { EditorialNotificationAdapter } from "../telegram/interfaces";
import type { TelegramUpdate } from "../telegram/models";
import type { FinalReviewControl } from "../telegram/service";
import type { DatabaseClient } from "../database/client";
import { productionReadiness } from "./readiness";
import { PostgresAutomationJobRepository } from "./repository";

const commands = new Set(["/system_status", "/jobs", "/retry", "/cancel_job"]);

interface ResearchRecoveryJobs {
  showActionableJobs(actor: TelegramActor): Promise<void>;
}

type OperationsJobs = Pick<
  PostgresAutomationJobRepository,
  "list" | "retry" | "cancel"
>;

export class OperationsTelegramController implements FinalReviewControl {
  private readonly jobs: OperationsJobs;

  constructor(
    private readonly deps: {
      sql: DatabaseClient;
      adapter: EditorialNotificationAdapter;
      environment?: NodeJS.ProcessEnv;
      jobs?: OperationsJobs;
      researchRecovery?: ResearchRecoveryJobs;
    },
  ) {
    this.jobs = deps.jobs ?? new PostgresAutomationJobRepository(deps.sql);
  }

  handlesCommand(command: string | undefined) {
    return Boolean(command && commands.has(command));
  }

  async processCommand(
    command: string,
    rest: string,
    _update: TelegramUpdate,
    actor: TelegramActor,
  ) {
    if (command === "/system_status") {
      const status = await productionReadiness(
        this.deps.sql,
        this.deps.environment ?? process.env,
      );
      const missing = status.missing.length
        ? status.missing.map(category).join(", ")
        : "none";
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        `<b>System ${status.ready ? "ready ✓" : "not ready"}</b>\nDatabase: ${status.components.database} · migration ${status.database.migration}\nWebhook: ${status.components.webhook}\nScheduler: ${status.components.scheduler} · ${status.components.schedulerSource}\nWorker: ${status.components.worker}\nGitHub: ${status.components.github} · Vercel: ${status.components.vercel}\nAI provider: ${status.components.llm}\nMissing setup: ${missing}`,
      );
      return;
    }
    if (command === "/jobs") {
      const mode = rest.trim().toLowerCase();
      if (!mode) {
        if (this.deps.researchRecovery)
          await this.deps.researchRecovery.showActionableJobs(actor);
        else
          await this.deps.adapter.sendStatusMessage(
            actor.chatId,
            "<b>No actionable automation jobs</b>\nUse /jobs all to view automation history.",
          );
        return;
      }
      if (mode !== "all")
        throw new TelegramControlError(
          "invalid_command",
          "Usage: /jobs or /jobs all",
        );
      const values = await this.jobs.list(undefined, 25);
      const text = values.length
        ? values
            .map(
              (job) =>
                `${job.id} · ${job.type} · ${job.status}${job.diagnosticId ? ` · ${job.diagnosticId}` : ""}`,
            )
            .join("\n")
        : "No automation history.";
      await this.deps.adapter.sendStatusMessage(
        actor.chatId,
        `<b>Automation history</b>\n${text}`,
      );
      return;
    }
    const id = rest.trim();
    if (!/^automationjob_[a-f0-9]{24}$/.test(id))
      throw new TelegramControlError(
        "invalid_command",
        `Usage: ${command} automationjob_…`,
      );
    const value =
      command === "/retry"
        ? await this.jobs.retry(id)
        : await this.jobs.cancel(id);
    await this.deps.adapter.sendStatusMessage(
      actor.chatId,
      `${value.type} job is now ${value.status}.`,
    );
  }

  async processCallback() {
    throw new TelegramControlError(
      "stale_callback",
      "This operations action is no longer available",
    );
  }

  async processConversationText() {
    return false;
  }
}

function category(name: string) {
  if (name.includes("GOOGLE_AI")) return "AI provider key";
  if (name.includes("TELEGRAM")) return "Telegram configuration";
  if (name.includes("BLOG_")) return "GitHub configuration";
  if (name === "CONTROL_PLANE_ORIGIN") return "hosted URL";
  if (name === "CRON_SECRET") return "scheduler secret";
  if (name === "DATABASE_URL") return "database";
  return "runtime configuration";
}
