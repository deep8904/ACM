import { readFile } from "node:fs/promises";
import { createRepositoryComposition } from "../storage/composition";
import { loadAnalyticsConfig } from "./config";
import { AnalyticsService } from "./service";

const args = process.argv.slice(2),
  command = args[0] ?? "status";
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = (name: string) => {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const fixture = option("--fixtures"),
  root = fixture ?? "data";
const analyticsRoot = fixture
  ? `${root}/analytics`
  : (process.env.ANALYTICS_STATE_DIRECTORY ?? "data/analytics");
const taskRoot = fixture
  ? `${root}/tasks/analytics`
  : (process.env.ANALYTICS_TASK_DIRECTORY ?? "data/tasks/analytics");
const publicationRoot = fixture
  ? `${root}/publication`
  : (process.env.PUBLICATION_STATE_DIRECTORY ?? "data/publication");
const socialRoot = fixture
  ? `${root}/social`
  : (process.env.SOCIAL_STATE_DIRECTORY ?? "data/social");
const configPath =
  process.env.ANALYTICS_CONFIG ?? "automation/config/analytics.example.yaml";
const config = await loadAnalyticsConfig(configPath);
const composition = createRepositoryComposition(
  fixture
    ? {
        ...process.env,
        NODE_ENV: "test",
        STORAGE_BACKEND: "file",
        ANALYTICS_STATE_DIRECTORY: analyticsRoot,
        ANALYTICS_TASK_DIRECTORY: taskRoot,
        PUBLICATION_STATE_DIRECTORY: publicationRoot,
        SOCIAL_STATE_DIRECTORY: socialRoot,
      }
    : process.env,
);
await composition.verify();
const {
  sources,
  syncJobs,
  articleMetrics,
  socialMetrics,
  snapshots,
  insights,
  reports,
  imports,
  tasks,
  publications,
  postedRecords,
} = composition.analytics;
const service = new AnalyticsService({
  sources,
  syncJobs,
  articleMetrics,
  socialMetrics,
  snapshots,
  insights,
  reports,
  imports,
  tasks,
  publications,
  postedRecords,
  config,
});
await service.configureSources(await readFile(configPath, "utf8"));
let output: unknown;
if (command === "status") output = await service.status();
else if (command === "sync")
  output = await service.sync(
    option("--provider"),
    option("--from"),
    option("--to"),
  );
else if (command === "import")
  output = await service.importFile(required("--provider"), required("--file"));
else if (command === "article")
  output = await service.article(required("--publication-id"));
else if (command === "social")
  output = await service.social(required("--publication-id"));
else if (command === "snapshot")
  output = await service.snapshot(
    required("--publication-id"),
    required("--period"),
  );
else if (command === "insights") output = await service.generateInsights();
else if (command === "report-weekly")
  output = await service.report("weekly", option("--from"), option("--to"));
else if (command === "report-monthly")
  output = await service.report("monthly", option("--from"), option("--to"));
else if (command === "report")
  output = await service.report("custom", required("--from"), required("--to"));
else if (command === "analysis-prepare")
  output = await service.prepareAnalysis(required("--report-id"));
else if (command === "analysis-import")
  output = await service.importAnalysis(
    required("--report-id"),
    required("--file"),
  );
else if (command === "export") {
  const report = (await service.reports()).find(
    (value) => value.id === required("--report-id"),
  );
  if (!report) throw new Error("Editorial report not found");
  output = {
    reportId: report.id,
    directory:
      composition.backend === "postgres"
        ? `postgres://content_machine/editorial_reports/${report.id}`
        : `${analyticsRoot}/reports/${report.id}`,
  };
} else if (command === "cleanup")
  output = await service.cleanup(
    args.includes("--dry-run"),
    option("--confirm-cleanup") === "yes",
  );
else throw new Error(`Unknown analytics command: ${command}`);
console.log(JSON.stringify(output, null, 2));
await composition.close();
