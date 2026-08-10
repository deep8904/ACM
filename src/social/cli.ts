import {
  loadPublicationConfig,
  publicationConfigSchema,
} from "../publication/config";
import {
  GitHubContentRepository,
  LocalContentRepository,
} from "../publication/repository";
import { createRepositoryComposition } from "../storage/composition";
import { loadSocialConfig } from "./config";
import { SocialService } from "./service";
import { SocialDistributionService } from "./distribution";
import { SocialPublisherRegistry } from "./publishers";
import {
  socialPlatformSchema,
  socialRevisionSchema,
  type SocialPlatform,
} from "./models";
const args = process.argv.slice(2),
  command = args[0] ?? "status",
  option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  },
  required = (name: string) => {
    const x = option(name);
    if (!x) throw new Error(`${name} is required`);
    return x;
  },
  positive = (name: string) => {
    const x = Number(required(name));
    if (!Number.isInteger(x) || x < 1)
      throw new Error(`${name} must be a positive integer`);
    return x;
  };
const fixture = option("--fixtures"),
  root = fixture ?? "data",
  pathFor = (relative: string, env: string, fallback: string) =>
    fixture ? `${root}/${relative}` : (process.env[env] ?? fallback),
  social = await loadSocialConfig(
    process.env.SOCIAL_CONFIG ?? "automation/config/social.example.yaml",
  ),
  pubFile = await loadPublicationConfig(
    process.env.PUBLICATION_CONFIG ??
      "automation/config/publication.example.yaml",
  ),
  pub = publicationConfigSchema.parse({
    ...pubFile,
    repository: process.env.BLOG_REPOSITORY ?? pubFile.repository,
    defaultBranch: process.env.BLOG_DEFAULT_BRANCH ?? pubFile.defaultBranch,
    contentRoot: process.env.BLOG_CONTENT_ROOT ?? pubFile.contentRoot,
    siteOrigin: process.env.SITE_ORIGIN ?? pubFile.siteOrigin,
    blogRoutePrefix: process.env.BLOG_ROUTE_PREFIX ?? pubFile.blogRoutePrefix,
  });
const publicationRoot = pathFor(
    "publication",
    "PUBLICATION_STATE_DIRECTORY",
    "data/publication",
  ),
  socialRoot = pathFor("social", "SOCIAL_STATE_DIRECTORY", "data/social"),
  taskRoot = pathFor(
    "tasks/social",
    "SOCIAL_TASK_DIRECTORY",
    "data/tasks/social",
  ),
  revisionRoot = pathFor(
    "tasks/social-revision",
    "SOCIAL_REVISION_TASK_DIRECTORY",
    "data/tasks/social-revision",
  ),
  content =
    pub.mode === "fixture"
      ? new LocalContentRepository(
          option("--repository-root") ??
            process.env.BLOG_FIXTURE_ROOT ??
            `${root}/fixture-blog`,
          pub.defaultBranch,
        )
      : new GitHubContentRepository({
          token: process.env.BLOG_GITHUB_TOKEN ?? "",
          repository: pub.repository,
          defaultBranch: pub.defaultBranch,
        });
const composition = createRepositoryComposition(
  fixture
    ? {
        ...process.env,
        NODE_ENV: "test",
        STORAGE_BACKEND: "file",
        PUBLICATION_STATE_DIRECTORY: publicationRoot,
        SOCIAL_STATE_DIRECTORY: socialRoot,
        SOCIAL_TASK_DIRECTORY: taskRoot,
        SOCIAL_REVISION_TASK_DIRECTORY: revisionRoot,
      }
    : process.env,
);
await composition.verify();
const {
  packages,
  quality,
  jobs,
  tasks,
  approvals,
  history,
  exports,
  posted,
  revisions,
} = composition.social;
const service = new SocialService({
  publications: composition.publication.productionArtifacts,
  content,
  jobs,
  packages,
  quality,
  tasks,
  approvals,
  history,
  exports,
  posted,
  revisions,
  config: social,
  paths: {
    prompt: "prompts/social-package.md",
    audience: "brand/audience.md",
    writing: "brand/writing-style.md",
    editorial: "brand/editorial-rules.md",
    design: "brand/design-style.md",
  },
});
const distribution = new SocialDistributionService({
  social: service,
  plans: composition.social.plans,
  assets: composition.social.assets,
  packages,
  exports,
  publishers: new SocialPublisherRegistry(),
  config: social,
});
const publicationId = () => required("--publication-id"),
  platform = () => socialPlatformSchema.parse(required("--platform")),
  version = () => positive("--version");
let output: unknown;
if (command === "offer") output = await distribution.offer(publicationId());
else if (command === "select") {
  let plan = await distribution.offer(publicationId());
  const selected =
    option("--platforms")
      ?.split(",")
      .filter(Boolean)
      .map((value) => socialPlatformSchema.parse(value)) ?? [];
  for (const value of selected)
    if (!plan.selectedPlatforms.includes(value))
      plan = await distribution.toggle(plan.id, value, plan.selectionRevision);
  output = plan;
} else if (command === "distribute") {
  let plan = await distribution.offer(publicationId());
  const selected = required("--platforms")
    .split(",")
    .filter(Boolean)
    .map((value) => socialPlatformSchema.parse(value));
  for (const value of selected)
    if (!plan.selectedPlatforms.includes(value))
      plan = await distribution.toggle(plan.id, value, plan.selectionRevision);
  output = await distribution.prepare(
    plan.id,
    plan.selectionRevision,
    undefined,
    args.includes("--regenerate"),
  );
} else if (command === "distribution-status") {
  const plan = await distribution.getPlanByPublication(publicationId());
  output = plan ? await distribution.status(plan.id) : undefined;
} else if (command === "distribution-confirm") {
  const plan = await distribution.getPlanByPublication(publicationId());
  if (!plan) throw new Error("Distribution plan not found");
  output = await distribution.confirm(plan.id);
} else if (command === "distribution-assets") {
  const plan = await distribution.getPlanByPublication(publicationId());
  if (!plan) throw new Error("Distribution plan not found");
  output = await distribution.materializeAssets(
    plan.id,
    required("--output-dir"),
  );
} else if (command === "prepare")
  output = await service.prepare(
    publicationId(),
    option("--platforms")?.split(",").filter(Boolean) as
      SocialPlatform[] | undefined,
  );
else if (command === "status") output = await service.status(publicationId());
else if (command === "task") {
  const status = await service.status(publicationId());
  const packageVersion = status.job?.packageVersion;
  output = {
    publicationId: publicationId(),
    packageVersion,
    available: packageVersion
      ? Boolean(await tasks.readInput(publicationId(), packageVersion))
      : false,
    taskDirectory: packageVersion
      ? composition.backend === "postgres"
        ? `postgres://content_machine/social_tasks/${publicationId()}/v${packageVersion}`
        : `${taskRoot}/${publicationId()}/v${packageVersion}`
      : undefined,
  };
} else if (command === "import")
  output = await service.import(publicationId(), required("--file"));
else if (command === "package")
  output = await service.package(
    publicationId(),
    option("--version") ? version() : undefined,
  );
else if (command === "quality")
  output = await service.quality(
    publicationId(),
    option("--version") ? version() : undefined,
  );
else if (command === "export")
  output = await service.export(
    publicationId(),
    option("--version")
      ? version()
      : ((await service.getPackageRecord(publicationId()))?.version ?? 0),
  );
else if (command === "approve")
  output = await service.approve(
    publicationId(),
    platform(),
    version(),
    "approve",
  );
else if (command === "schedule")
  output = await service.approve(
    publicationId(),
    platform(),
    version(),
    "schedule",
    { publishAt: required("--publish-at") },
  );
else if (command === "mark-posted")
  output = await service.markPosted(
    publicationId(),
    platform(),
    required("--post-url"),
  );
else if (command === "revise-prepare")
  output = await service.prepareRevision(
    publicationId(),
    version(),
    socialRevisionSchema.shape.scope.parse(required("--scope")),
    required("--instruction"),
  );
else if (command === "revise-import")
  output = await service.importRevision(
    publicationId(),
    version(),
    required("--file"),
  );
else throw new Error(`Unknown social command: ${command}`);
console.log(JSON.stringify(output, null, 2));
await composition.close();
