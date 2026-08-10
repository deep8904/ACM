import { readFile } from "node:fs/promises";
import { createRepositoryComposition } from "../storage/composition";
import { loadPublicationConfig, publicationConfigSchema } from "./config";
import {
  ManualDeploymentProvider,
  MockDeploymentProvider,
  VercelGitDeploymentProvider,
  VercelGitHubDeploymentProvider,
} from "./deployment";
import { GitHubContentRepository, LocalContentRepository } from "./repository";
import { PublicationService } from "./service";
import { PublicationRepublishService } from "./republish";
import { PublicationRepublishVerificationService } from "./republish-verification";
import { loadSocialConfig } from "../social/config";
import { SocialService } from "../social/service";
import { SocialDistributionService } from "../social/distribution";
import { SocialPublisherRegistry } from "../social/publishers";
import { SocialTelegramController } from "../social/telegram";
import { requireTelegramRuntimeConfig } from "../telegram/config";
import { TelegramBotApiClient } from "../telegram/telegram-client";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const required = (name: string) => {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const fixture = option("--fixtures");
const root = fixture ?? "data";
const pathFor = (
  fixturePath: string,
  environmentName: string,
  fallback: string,
) =>
  fixture
    ? `${root}/${fixturePath}`
    : (process.env[environmentName] ?? fallback);
const fileConfig = await loadPublicationConfig(
  process.env.PUBLICATION_CONFIG ??
    "automation/config/publication.example.yaml",
);
const config = publicationConfigSchema.parse({
  ...fileConfig,
  repository: process.env.BLOG_REPOSITORY ?? fileConfig.repository,
  defaultBranch: process.env.BLOG_DEFAULT_BRANCH ?? fileConfig.defaultBranch,
  contentRoot: process.env.BLOG_CONTENT_ROOT ?? fileConfig.contentRoot,
  siteOrigin: process.env.SITE_ORIGIN ?? fileConfig.siteOrigin,
  blogRoutePrefix: process.env.BLOG_ROUTE_PREFIX ?? fileConfig.blogRoutePrefix,
  deploymentProvider:
    process.env.PUBLICATION_DEPLOYMENT_PROVIDER ??
    fileConfig.deploymentProvider,
});
if (config.mode === "github" && !process.env.BLOG_GITHUB_TOKEN)
  throw new Error("BLOG_GITHUB_TOKEN is required for GitHub publication");
const state = pathFor(
  "publication",
  "PUBLICATION_STATE_DIRECTORY",
  "data/publication",
);
const writingRoot = pathFor(
  "writing",
  "WRITING_STATE_DIRECTORY",
  "data/writing",
);
const researchRoot = pathFor(
  "research",
  "RESEARCH_STATE_DIRECTORY",
  "data/research",
);
const reviewRoot = pathFor("review", "REVIEW_STATE_DIRECTORY", "data/review");
const finalRoot = pathFor(
  "final-approval",
  "FINAL_APPROVAL_STATE_DIRECTORY",
  "data/final-approval",
);
const telegramRoot = pathFor(
  "telegram",
  "TELEGRAM_STATE_DIRECTORY",
  "data/telegram",
);
const eventRoot = pathFor(
  "events/article-final-approved",
  "ARTICLE_EVENT_DIRECTORY",
  "data/events/article-final-approved",
);
const taskRoot = pathFor(
  "tasks/publication",
  "PUBLICATION_TASK_DIRECTORY",
  "data/tasks/publication",
);
const composition = createRepositoryComposition(
  fixture
    ? {
        ...process.env,
        NODE_ENV: "test",
        STORAGE_BACKEND: "file",
        PUBLICATION_STATE_DIRECTORY: state,
        WRITING_STATE_DIRECTORY: writingRoot,
        RESEARCH_STATE_DIRECTORY: researchRoot,
        REVIEW_STATE_DIRECTORY: reviewRoot,
        FINAL_APPROVAL_STATE_DIRECTORY: finalRoot,
        TELEGRAM_STATE_DIRECTORY: telegramRoot,
        ARTICLE_EVENT_DIRECTORY: eventRoot,
        PUBLICATION_TASK_DIRECTORY: taskRoot,
      }
    : process.env,
);
await composition.verify();
const { drafts, quality } = composition.writing;
const repository =
  config.mode === "fixture"
    ? new LocalContentRepository(
        option("--repository-root") ??
          process.env.BLOG_FIXTURE_ROOT ??
          `${root}/fixture-blog`,
        config.defaultBranch,
      )
    : new GitHubContentRepository({
        token: process.env.BLOG_GITHUB_TOKEN!,
        repository: config.repository,
        defaultBranch: config.defaultBranch,
      });
const deployment =
  config.deploymentProvider === "mock"
    ? new MockDeploymentProvider()
    : config.deploymentProvider === "manual"
      ? new ManualDeploymentProvider()
      : process.env.VERCEL_DEPLOYMENT_METADATA_SOURCE === "github"
        ? new VercelGitHubDeploymentProvider({
            token: process.env.BLOG_GITHUB_TOKEN ?? "",
            repository: config.repository,
          })
        : new VercelGitDeploymentProvider({
            token: process.env.VERCEL_TOKEN ?? "",
            projectId: process.env.VERCEL_PROJECT_ID ?? "",
            teamId: process.env.VERCEL_TEAM_ID,
          });
const service = new PublicationService({
  events: composition.publication.events,
  jobs: composition.publication.jobs,
  publications: composition.publication.publications,
  consumption: composition.publication.consumption,
  deployments: composition.publication.deployments,
  verifications: composition.publication.verifications,
  drafts,
  quality,
  packets: composition.research.packets,
  reviews: composition.review.reviews,
  approvals: composition.review.approvals,
  gates: composition.review.gates,
  repository,
  deployment,
  config,
  tasks: composition.publication.tasks,
});
const republishService = new PublicationRepublishService({
  publications: composition.publication.publications,
  republishes: composition.publication.republishes,
  consumption: composition.publication.consumption,
  events: composition.publication.events,
  drafts,
  reviews: composition.review.reviews,
  sourceRepository: new LocalContentRepository(
    process.env.BLOG_FIXTURE_ROOT ?? "data/fixture-blog",
    config.defaultBranch,
  ),
  targetRepository: repository,
  config,
});
const republishVerificationService =
  new PublicationRepublishVerificationService({
    publications: composition.publication.publications,
    republishes: composition.publication.republishes,
    productionArtifacts: composition.publication.productionArtifacts,
    repository,
    deployment,
    config,
  });
let output: unknown;
if (command === "next")
  output = await service.next(
    option("--worker-id") ?? undefined,
    args.includes("--dry-run"),
  );
else if (command === "event")
  output = await service.event(
    required("--event-id"),
    option("--worker-id") ?? undefined,
    args.includes("--dry-run"),
  );
else if (command === "due")
  output = await service.due(
    option("--worker-id") ?? undefined,
    args.includes("--dry-run"),
  );
else if (command === "status")
  output = await service.status(required("--event-id"));
else if (command === "verify")
  output = await service.importVerification(
    required("--publication-id"),
    JSON.parse(await readFile(required("--file"), "utf8")),
  );
else if (command === "republish")
  output = await republishService.republish({
    sourcePublicationId: required("--source-publication-id"),
    expectedRepository: required("--expected-repository"),
    expectedBaseBranch: required("--expected-base-branch"),
    expectedSourceContentHash: required("--expected-source-content-hash"),
    expectedApprovedSnapshotHash: required("--expected-approved-snapshot-hash"),
    expectedPublishedSnapshotHash: required(
      "--expected-published-snapshot-hash",
    ),
    dryRun: args.includes("--dry-run"),
  });
else if (command === "republish-verify") {
  const result = await republishVerificationService.verify({
    republishId: required("--republish-id"),
    dryRun: args.includes("--dry-run"),
    manualVerificationAcknowledged: args.includes(
      "--manual-verification-acknowledged",
    ),
  });
  output = result;
  if (!result.dryRun && result.artifact && process.env.TELEGRAM_BOT_TOKEN)
    await sendDistributionOffer(result.artifact.id);
} else if (command === "republish-status")
  output = await republishVerificationService.status(
    required("--republish-id"),
  );
else throw new Error(`Unknown publication command: ${command}`);
console.log(JSON.stringify(output, null, 2));
await composition.close();

async function sendDistributionOffer(publicationId: string) {
  const telegram = requireTelegramRuntimeConfig(process.env, "api");
  const socialConfig = await loadSocialConfig(
    process.env.SOCIAL_CONFIG ?? "automation/config/social.example.yaml",
  );
  const social = new SocialService({
    publications: composition.publication.productionArtifacts,
    content: repository,
    jobs: composition.social.jobs,
    packages: composition.social.packages,
    quality: composition.social.quality,
    tasks: composition.social.tasks,
    approvals: composition.social.approvals,
    history: composition.social.history,
    exports: composition.social.exports,
    posted: composition.social.posted,
    revisions: composition.social.revisions,
    config: socialConfig,
    paths: {
      prompt: "prompts/social-package.md",
      audience: "brand/audience.md",
      writing: "brand/writing-style.md",
      editorial: "brand/editorial-rules.md",
      design: "brand/design-style.md",
    },
  });
  const distribution = new SocialDistributionService({
    social,
    plans: composition.social.plans,
    assets: composition.social.assets,
    packages: composition.social.packages,
    exports: composition.social.exports,
    publishers: new SocialPublisherRegistry(),
    config: socialConfig,
  });
  const controller = new SocialTelegramController({
    service: social,
    publications: composition.publication.productionArtifacts,
    adapter: new TelegramBotApiClient({
      botToken: telegram.TELEGRAM_BOT_TOKEN as string,
    }),
    callbackSecret: telegram.callbackSecret,
    config: socialConfig,
    conversations: composition.social.conversations,
    distribution,
  });
  for (const chatId of telegram.TELEGRAM_ALLOWED_CHAT_IDS)
    await controller.sendDistributionOffer(chatId, publicationId);
}
