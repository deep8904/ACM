import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { analyticsConfigSchema } from "../analytics/config";
import { AnalyticsService } from "../analytics/service";
import { createRepositoryComposition } from "../storage/composition";
import { AnalyticsTelegramController } from "../analytics/telegram";
import { publicationConfigSchema } from "../publication/config";
import {
  ManualDeploymentProvider,
  MockDeploymentProvider,
  VercelGitDeploymentProvider,
} from "../publication/deployment";
import {
  GitHubContentRepository,
  LocalContentRepository,
} from "../publication/repository";
import { PublicationService } from "../publication/service";
import { PublicationTelegramController } from "../publication/telegram";
import { socialConfigSchema } from "../social/config";
import { SocialService } from "../social/service";
import { SocialTelegramController } from "../social/telegram";
import { SocialDistributionService } from "../social/distribution";
import { SocialPublisherRegistry } from "../social/publishers";
import { reviewConfigSchema } from "../review/config";
import { FinalApprovalService } from "../review/final-approval";
import { RevisionService } from "../review/revision";
import { FinalReviewTelegramController } from "../review/telegram";
import { writingConfigSchema } from "../writing/config";
import { requireTelegramRuntimeConfig } from "./config";
import { TopicApprovalService } from "./service";
import { TelegramBotApiClient } from "./telegram-client";
import { createTelegramWebhookHandler } from "./webhook";
import { createRemotePreviewUrl } from "../review/preview-url";
import { OperationsTelegramController } from "../orchestration/telegram";
import { PostgresAutomationJobRepository } from "../orchestration/repository";
import { researchConfigSchema } from "../research/config";
import { ResearchService } from "../research/service";
import {
  PostgresResearchRemediationRepository,
  ResearchRemediationService,
  ResearchRemediationTelegramController,
  researchRemediationCallbackSecret,
} from "../research/remediation";

export function buildTelegramWebhookHandler(
  source: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = requireTelegramRuntimeConfig(source, "webhook");
  const composition = createRepositoryComposition(source as NodeJS.ProcessEnv);
  const repository = composition.telegram;
  const adapter = new TelegramBotApiClient({
    botToken: config.TELEGRAM_BOT_TOKEN as string,
  });
  const reviewConfig = reviewConfigSchema.parse(
    parse(
      readFileSync(
        /* turbopackIgnore: true */
        source.REVIEW_CONFIG ?? "automation/config/review.example.yaml",
        "utf8",
      ),
    ),
  );
  const writingConfig = writingConfigSchema.parse(
    parse(
      readFileSync(
        /* turbopackIgnore: true */
        source.WRITING_CONFIG ?? "automation/config/writing.example.yaml",
        "utf8",
      ),
    ),
  );
  const { drafts, quality, history } = composition.writing;
  const packets = composition.research.packets;
  const { reviews, revisions, approvals, events, previews, gates } =
    composition.review;
  const publicationConfig = publicationConfigSchema.parse(
    parse(
      readFileSync(
        /* turbopackIgnore: true */
        source.PUBLICATION_CONFIG ??
          "automation/config/publication.example.yaml",
        "utf8",
      ),
    ),
  );
  const publications = composition.publication.publications;
  const productionPublications = composition.publication.productionArtifacts;
  const blogRepository =
    publicationConfig.mode === "fixture"
      ? new LocalContentRepository(
          source.BLOG_FIXTURE_ROOT ?? "data/fixture-blog",
          publicationConfig.defaultBranch,
        )
      : new GitHubContentRepository({
          token: source.BLOG_GITHUB_TOKEN ?? "",
          repository: source.BLOG_REPOSITORY ?? publicationConfig.repository,
          defaultBranch:
            source.BLOG_DEFAULT_BRANCH ?? publicationConfig.defaultBranch,
        });
  const finalService = new FinalApprovalService({
    drafts,
    quality,
    packets,
    reviews,
    revisions,
    approvals,
    events,
    gates,
    config: reviewConfig,
  });
  const revisionService = new RevisionService({
    drafts,
    quality,
    packets,
    reviews,
    tasks: revisions,
    approvals,
    events,
    previews,
    gates,
    history,
    writingConfig,
  });
  const publicationService = new PublicationService({
    events: composition.publication.events,
    jobs: composition.publication.jobs,
    publications,
    consumption: composition.publication.consumption,
    deployments: composition.publication.deployments,
    verifications: composition.publication.verifications,
    drafts,
    quality,
    packets,
    reviews,
    approvals,
    gates,
    repository: blogRepository,
    deployment:
      publicationConfig.deploymentProvider === "manual"
        ? new ManualDeploymentProvider()
        : publicationConfig.deploymentProvider === "mock"
          ? new MockDeploymentProvider()
          : new VercelGitDeploymentProvider({
              token: source.VERCEL_TOKEN ?? "",
              projectId: source.VERCEL_PROJECT_ID ?? "",
              teamId: source.VERCEL_TEAM_ID,
            }),
    config: publicationConfig,
    tasks: composition.publication.tasks,
  });
  const socialConfig = socialConfigSchema.parse(
    parse(
      readFileSync(
        /* turbopackIgnore: true */
        source.SOCIAL_CONFIG ?? "automation/config/social.example.yaml",
        "utf8",
      ),
    ),
  );
  const socialPackages = composition.social.packages;
  const socialService = new SocialService({
    publications: productionPublications,
    content: blogRepository,
    jobs: composition.social.jobs,
    packages: socialPackages,
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
  const socialDistribution = new SocialDistributionService({
    social: socialService,
    plans: composition.social.plans,
    assets: composition.social.assets,
    packages: socialPackages,
    exports: composition.social.exports,
    publishers: new SocialPublisherRegistry(),
    config: socialConfig,
  });
  const analyticsConfig = analyticsConfigSchema.parse(
    parse(
      readFileSync(
        /* turbopackIgnore: true */
        source.ANALYTICS_CONFIG ?? "automation/config/analytics.example.yaml",
        "utf8",
      ),
    ),
  );
  const analyticsService = new AnalyticsService({
    sources: composition.analytics.sources,
    syncJobs: composition.analytics.syncJobs,
    articleMetrics: composition.analytics.articleMetrics,
    socialMetrics: composition.analytics.socialMetrics,
    snapshots: composition.analytics.snapshots,
    insights: composition.analytics.insights,
    reports: composition.analytics.reports,
    imports: composition.analytics.imports,
    tasks: composition.analytics.tasks,
    publications: productionPublications,
    postedRecords: composition.analytics.postedRecords,
    config: analyticsConfig,
  });
  const topicControl: { current?: TopicApprovalService } = {};
  const researchRemediation = composition.sql
    ? (() => {
        const researchConfig = researchConfigSchema.parse(
          parse(
            readFileSync(
              /* turbopackIgnore: true */
              source.RESEARCH_CONFIG ??
                "automation/config/research.example.yaml",
              "utf8",
            ),
          ),
        );
        const remediationRepository = new PostgresResearchRemediationRepository(
          composition.sql,
        );
        const researchService = new ResearchService({
          events: composition.research.events,
          jobs: composition.research.jobs,
          packets: composition.research.packets,
          sources: composition.research.sources,
          cache: composition.research.cache,
          extensions: composition.research.extensions,
          humanEvidence: composition.research.humanEvidence,
          catalog: composition.catalog,
          config: researchConfig,
        });
        return new ResearchRemediationTelegramController({
          service: new ResearchRemediationService({
            remediation: remediationRepository,
            research: researchService,
            packets: composition.research.packets,
            events: composition.research.events,
            topics: repository,
            jobs: new PostgresAutomationJobRepository(composition.sql),
            ttlMinutes: config.TELEGRAM_CONVERSATION_TTL_MINUTES,
          }),
          repository: remediationRepository,
          adapter,
          callbackSecret: researchRemediationCallbackSecret(
            config.TELEGRAM_BOT_TOKEN as string,
          ),
          cancelTopic: (topicId, update, actor) =>
            requiredTopicControl(topicControl).cancel(topicId, update, actor),
          refreshTopics: (chatId) =>
            requiredTopicControl(topicControl).showTopics(chatId),
        });
      })()
    : undefined;
  const service = new TopicApprovalService({
    adapter,
    repository,
    catalog: composition.catalog,
    config,
    researchRemediation,
    operations: composition.sql
      ? new OperationsTelegramController({
          sql: composition.sql,
          adapter,
          environment: source as NodeJS.ProcessEnv,
          researchRecovery: researchRemediation,
        })
      : undefined,
    analytics: new AnalyticsTelegramController({
      service: analyticsService,
      publications: productionPublications,
      adapter,
      callbackSecret: config.callbackSecret,
      config: analyticsConfig,
    }),
    social: new SocialTelegramController({
      service: socialService,
      publications: productionPublications,
      adapter,
      callbackSecret: config.callbackSecret,
      config: socialConfig,
      conversations: composition.social.conversations,
      distribution: socialDistribution,
    }),
    publication: new PublicationTelegramController({
      publications,
      adapter,
      retryDeployment: (topicId) =>
        publicationService.retryDeployment(topicId).then(() => undefined),
    }),
    finalReview: new FinalReviewTelegramController({
      service: finalService,
      revision: revisionService,
      reviews,
      drafts,
      quality,
      previews,
      approvals,
      conversations: composition.review.conversations,
      adapter,
      callbackSecret: config.callbackSecret,
      config: reviewConfig,
      previewUrl: (preview) => createRemotePreviewUrl(preview, source),
    }),
  });
  topicControl.current = service;
  const handler = createTelegramWebhookHandler({
    secrets: config.webhookSecrets,
    service,
  });
  let verified = false;
  return async (request: Request) => {
    if (!verified) {
      await composition.verify();
      verified = true;
    }
    if (composition.sql)
      await new PostgresAutomationJobRepository(
        composition.sql,
      ).heartbeatComponent({
        component: "webhook",
        instanceId: source.VERCEL_REGION ?? "hosted-webhook",
        status: "healthy",
        details: {},
        observedAt: new Date().toISOString(),
      });
    return handler(request);
  };
}

function requiredTopicControl(value: { current?: TopicApprovalService }) {
  if (!value.current) throw new Error("Telegram topic control is not ready");
  return value.current;
}
