import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createRepositoryComposition } from "../storage/composition";
import { importAssistance, writeAssistanceTask } from "./assisted";
import { loadResearchConfig } from "./config";
import { ResearchService } from "./service";

const [command = "status", argument] = process.argv.slice(2);
const root = process.env.RESEARCH_STATE_DIRECTORY ?? "data/research";
const config = await loadResearchConfig(
  process.env.RESEARCH_CONFIG ?? "automation/config/research.example.yaml",
);
const fixtureRoot = option("--fixtures");
const composition = createRepositoryComposition(
  fixtureRoot
    ? {
        ...process.env,
        NODE_ENV: "test",
        STORAGE_BACKEND: "file",
        RESEARCH_STATE_DIRECTORY: root,
      }
    : process.env,
);
await composition.verify();
const {
  events,
  jobs,
  packets,
  sources,
  cache,
  tasks,
  imports,
  extensions,
  humanEvidence,
} = composition.research;
const service = new ResearchService({
  events,
  jobs,
  packets,
  sources,
  cache,
  extensions,
  humanEvidence,
  catalog: composition.catalog,
  config,
  fetch: fixtureRoot ? fixtureFetch(fixtureRoot) : undefined,
  lookup: fixtureRoot ? async () => ["93.184.216.34"] : undefined,
});
let output: unknown;
switch (command) {
  case "next":
    output = await service.next();
    break;
  case "event":
    if (!(option("--event-id") ?? argument))
      throw new Error("Usage: research:event -- --event-id <eventId>");
    output = await service.process(
      (option("--event-id") ?? argument) as string,
    );
    break;
  case "status":
    output = option("--job-id")
      ? await jobs.getById(option("--job-id") as string)
      : (option("--event-id") ?? argument)
        ? await jobs.getByEvent((option("--event-id") ?? argument) as string)
        : await events.next();
    break;
  case "packet":
    if (!(option("--topic-id") ?? argument))
      throw new Error("Usage: research:packet -- --topic-id <topicId>");
    output = await packets.get(
      (option("--topic-id") ?? argument) as string,
      Number(option("--version")) || undefined,
    );
    break;
  case "task": {
    if (!(option("--topic-id") ?? argument))
      throw new Error("Usage: research:task -- --topic-id <topicId>");
    const packet = await packets.get(
      (option("--topic-id") ?? argument) as string,
    );
    if (!packet) throw new Error("Packet not found");
    output = await writeAssistanceTask(
      packet,
      process.env.RESEARCH_TASK_DIRECTORY ?? "data/tasks/research",
      "prompts/research-synthesis.md",
      tasks,
    );
    break;
  }
  case "import":
    if (!(option("--file") ?? argument))
      throw new Error(
        "Usage: research:import -- --topic-id <topicId> --file <result.json>",
      );
    {
      const imported = await importAssistance(
        (option("--file") ?? argument) as string,
        packets,
        events,
        undefined,
        imports,
      );
      if (option("--topic-id") && imported.topicId !== option("--topic-id"))
        throw new Error("Imported result topic does not match --topic-id");
      output = imported;
    }
    break;
  case "retry":
    if (!(option("--job-id") ?? argument))
      throw new Error("Usage: research:retry -- --job-id <jobId>");
    {
      const requested = (option("--job-id") ?? argument) as string;
      const job = requested.startsWith("job_")
        ? await jobs.getById(requested)
        : await jobs.getByEvent(requested);
      if (!job) throw new Error("Research job not found");
      output = await service.retry(job.eventId);
    }
    break;
  case "add-source": {
    const topicId = option("--topic-id") ?? argument;
    const url = option("--url");
    const authority = option("--authority");
    const sourceType = option("--source-type");
    const publisher = option("--publisher");
    const publisherOwner = option("--publisher-owner");
    if (
      !topicId ||
      !url ||
      !authority ||
      !sourceType ||
      !publisher ||
      !publisherOwner
    )
      throw new Error(
        "Usage: research:add-source -- --topic-id <topicId> --url <httpsUrl> --authority <classification> --source-type <type> --publisher <name> --publisher-owner <domain>",
      );
    output = await service.extendSource({
      topicId,
      url,
      authority,
      sourceType,
      publisher,
      publisherOwner,
    } as never);
    break;
  }
  default:
    throw new Error(`Unknown research command: ${command}`);
}
if (
  (command === "next" || command === "event") &&
  output &&
  typeof output === "object" &&
  "status" in output &&
  output.status === "awaiting_assisted_synthesis"
)
  await writeAssistanceTask(
    output as never,
    process.env.RESEARCH_TASK_DIRECTORY ?? "data/tasks/research",
    "prompts/research-synthesis.md",
    tasks,
  );
process.stdout.write(
  `${JSON.stringify(output ?? { status: "no_work" }, null, 2)}\n`,
);
await composition.close();
function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function fixtureFetch(directory: string) {
  const rootPath = resolve(directory);
  return async (input: string) => {
    const url = new URL(input);
    const path = resolve(
      rootPath,
      url.hostname,
      decodeURIComponent(url.pathname).replace(/^\/+/, ""),
    );
    if (!path.startsWith(`${rootPath}${sep}`))
      return new Response("bad path", { status: 400 });
    try {
      const body = await readFile(path);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": contentType(extname(path)),
          "content-length": String(body.byteLength),
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
}
function contentType(extension: string) {
  return extension === ".html"
    ? "text/html"
    : extension === ".json"
      ? "application/json"
      : extension === ".pdf"
        ? "application/pdf"
        : extension === ".txt"
          ? "text/plain"
          : "application/xml";
}
