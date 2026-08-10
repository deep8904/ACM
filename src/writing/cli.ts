import { join, resolve } from "node:path";
import { createRepositoryComposition } from "../storage/composition";
import { loadWritingConfig } from "./config";
import { WritingService } from "./service";
import { sha256 } from "./task";

const [command = "status", argument] = process.argv.slice(2);
const topicId = option("--topic-id") ?? argument;
const version = Number(option("--research-version") ?? option("--version"));
const fixtureRoot = option("--fixtures");
const researchRoot = fixtureRoot
  ? `${fixtureRoot}/research`
  : (process.env.RESEARCH_STATE_DIRECTORY ?? "data/research");
const writingRoot = fixtureRoot
  ? `${fixtureRoot}/writing`
  : (process.env.WRITING_STATE_DIRECTORY ?? "data/writing");
const telegramRoot = fixtureRoot
  ? `${fixtureRoot}/telegram`
  : (process.env.TELEGRAM_STATE_DIRECTORY ?? "data/telegram");
const taskRoot = fixtureRoot
  ? `${fixtureRoot}/tasks/writing`
  : (process.env.WRITING_TASK_DIRECTORY ?? "data/tasks/writing");
const configPath =
  process.env.WRITING_CONFIG ?? "automation/config/writing.example.yaml";
const config = await loadWritingConfig(configPath);
const composition = createRepositoryComposition(
  fixtureRoot
    ? {
        ...process.env,
        NODE_ENV: "test",
        STORAGE_BACKEND: "file",
        RESEARCH_STATE_DIRECTORY: researchRoot,
        WRITING_STATE_DIRECTORY: writingRoot,
        TELEGRAM_STATE_DIRECTORY: telegramRoot,
        WRITING_TASK_DIRECTORY: taskRoot,
      }
    : process.env,
);
await composition.verify();
const { drafts, jobs, quality, history, tasks, gates } = composition.writing;
const service = new WritingService({
  packets: composition.research.packets,
  jobs,
  drafts,
  quality,
  history,
  tasks,
  gates,
  config,
  configHash: sha256(JSON.stringify(config)),
  paths: {
    prompt: "prompts/article-writer.md",
    audience: "brand/audience.md",
    style: "brand/writing-style.md",
    editorial: "brand/editorial-rules.md",
    design: "brand/design-style.md",
    template: "templates/article.mdx",
  },
});

let output: unknown;
switch (command) {
  case "prepare":
    requireTopic();
    requireVersion();
    output = await service.prepare(
      topicId as string,
      version,
      option("--article-type"),
      option("--slug"),
    );
    break;
  case "status":
    requireTopic();
    output = await service.status(topicId as string, version || undefined);
    break;
  case "task":
    requireTopic();
    requireVersion();
    output = {
      topicId,
      researchVersion: version,
      taskDirectory:
        composition.backend === "postgres"
          ? `postgres://content_machine/writing_tasks/${topicId}/v${version}`
          : resolve(join(taskRoot, topicId as string, `v${version}`)),
    };
    break;
  case "import":
    requireTopic();
    requireVersion();
    if (!option("--file"))
      throw new Error(
        "Usage: write:import -- --topic-id <id> --research-version <n> --file <result.json>",
      );
    {
      const imported = await service.import(
        topicId as string,
        version,
        resolve(option("--file") as string),
      );
      output = {
        reused: imported.reused,
        draftId: imported.draft.id,
        draftVersion: imported.draft.version,
        status: imported.draft.status,
        articleType: imported.draft.articleType,
        slug: imported.draft.slug,
        wordCount: imported.draft.wordCount,
        qualityStatus: imported.quality?.status,
        citationCoverageScore: imported.quality?.citationCoverage.score,
      };
    }
    break;
  case "draft":
    requireTopic();
    output = await service.draft(topicId as string, version || undefined);
    break;
  case "quality":
    requireTopic();
    output = await service.quality(topicId as string, version || undefined);
    break;
  case "retry":
    if (!option("--job-id"))
      throw new Error("Usage: write:retry -- --job-id <writingJobId>");
    {
      const job = await jobs.getById(option("--job-id") as string);
      if (!job) throw new Error("Writing job not found");
      output = await service.retry(job.topicId, job.researchPacketVersion);
    }
    break;
  case "cancel":
    if (!option("--job-id"))
      throw new Error("Usage: write:cancel -- --job-id <writingJobId>");
    {
      const job = await jobs.getById(option("--job-id") as string);
      if (!job) throw new Error("Writing job not found");
      output = await service.cancel(job.topicId, job.researchPacketVersion);
    }
    break;
  default:
    throw new Error(`Unknown writing command: ${command}`);
}
process.stdout.write(
  `${JSON.stringify(output ?? { status: "not_found" }, null, 2)}\n`,
);
await composition.close();
function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function requireTopic() {
  if (!topicId) throw new Error(`Usage: write:${command} -- --topic-id <id>`);
}
function requireVersion() {
  if (!Number.isInteger(version) || version < 1)
    throw new Error(
      `write:${command} requires --research-version <positive integer>`,
    );
}
