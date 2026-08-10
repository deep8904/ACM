import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubContentRepository, LocalContentRepository } from "../repository";
import {
  MockDeploymentProvider,
  VercelGitDeploymentProvider,
  VercelGitHubDeploymentProvider,
} from "../deployment";
import { digest } from "../transform";
import { RecordingTelegramAdapter } from "../../telegram/recording-adapter";
import { TelegramPublicationNotifications } from "../telegram";
describe("publication providers", () => {
  it("resolves a GitHub commit by branch name", async () => {
    const sha = "b".repeat(64);
    const parentSha = "a".repeat(64);
    const requested: string[] = [];
    const repo = new GitHubContentRepository({
      token: "not-logged",
      repository: "owner/repository",
      defaultBranch: "main",
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(
          JSON.stringify({
            sha,
            parents: [{ sha: parentSha }],
            html_url: `https://github.com/owner/repository/commit/${sha}`,
          }),
          { status: 200 },
        );
      },
    });

    await expect(repo.getCommit("main")).resolves.toEqual({
      sha,
      parentSha,
      branch: "main",
      url: `https://github.com/owner/repository/commit/${sha}`,
    });
    expect(requested).toEqual([
      "https://api.github.com/repos/owner/repository/commits/main",
    ]);
  });

  it("resolves a GitHub commit by a branch name containing slashes", async () => {
    const sha = "d".repeat(64);
    const parentSha = "c".repeat(64);
    const requested: string[] = [];
    const repo = new GitHubContentRepository({
      token: "not-logged",
      repository: "owner/repository",
      defaultBranch: "main",
      fetch: async (input) => {
        requested.push(String(input));
        if (requested.length === 1)
          return new Response(JSON.stringify({ object: { sha } }), {
            status: 200,
          });
        return new Response(
          JSON.stringify({
            sha,
            parents: [{ sha: parentSha }],
            html_url: `https://github.com/owner/repository/commit/${sha}`,
          }),
          { status: 200 },
        );
      },
    });

    await expect(repo.getCommit("republish/article-name")).resolves.toEqual({
      sha,
      parentSha,
      branch: "main",
      url: `https://github.com/owner/repository/commit/${sha}`,
    });
    expect(requested).toEqual([
      "https://api.github.com/repos/owner/repository/git/ref/heads/republish/article-name",
      `https://api.github.com/repos/owner/repository/commits/${sha}`,
    ]);
  });

  it("resolves a GitHub commit by SHA", async () => {
    const sha = "c".repeat(64);
    const parentSha = "b".repeat(64);
    const requested: string[] = [];
    const repo = new GitHubContentRepository({
      token: "not-logged",
      repository: "owner/repository",
      defaultBranch: "main",
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(
          JSON.stringify({
            sha,
            parents: [{ sha: parentSha }],
            html_url: `https://github.com/owner/repository/commit/${sha}`,
          }),
          { status: 200 },
        );
      },
    });

    await expect(repo.getCommit(sha)).resolves.toEqual({
      sha,
      parentSha,
      branch: "main",
      url: `https://github.com/owner/repository/commit/${sha}`,
    });
    expect(requested).toEqual([
      `https://api.github.com/repos/owner/repository/commits/${sha}`,
    ]);
  });

  it("checks GitHub ancestry with the compare API", async () => {
    const ancestor = "a".repeat(40),
      descendant = "b".repeat(40);
    const repo = new GitHubContentRepository({
      token: "not-logged",
      repository: "owner/repository",
      defaultBranch: "main",
      fetch: async (input) => {
        expect(String(input)).toBe(
          `https://api.github.com/repos/owner/repository/compare/${ancestor}...${descendant}`,
        );
        return new Response(JSON.stringify({ status: "ahead" }), {
          status: 200,
        });
      },
    });
    await expect(repo.isAncestor(ancestor, descendant)).resolves.toBe(true);
  });

  it("creates exactly one fixture commit per idempotency key", async () => {
    const root = await mkdtemp(join(tmpdir(), "publication-repo-"));
    const repo = new LocalContentRepository(root);
    const input = {
      branch: "main",
      expectedParentSha: "0".repeat(64),
      message: "publish: add Test",
      files: [{ path: "content/blog/2026/test.mdx", content: "safe" }],
      idempotencyKey: "articleevent_aaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const first = await repo.createCommit(input);
    const second = await repo.createCommit(input);
    expect(second.sha).toBe(first.sha);
    expect(await readFile(join(root, input.files[0]!.path), "utf8")).toBe(
      "safe",
    );
    expect((await repo.getFile(input.files[0]!.path))?.sha).toBe(
      digest("safe"),
    );
  });
  it("records mock deployment failure without another repository action", async () => {
    const x = await new MockDeploymentProvider(
      () => new Date("2026-08-06T12:00:00Z"),
      "failed",
    ).waitForDeployment({
      publicationId: "publication_aaaaaaaaaaaaaaaaaaaaaaaa",
      commitSha: "a".repeat(64),
      canonicalUrl: "https://example.com/blog/test",
      timeoutMs: 10,
      pollIntervalMs: 1,
    });
    expect(x.status).toBe("failed");
  });
  it("matches Vercel production deployment to exact commit SHA", async () => {
    const sha = "b".repeat(64);
    const provider = new VercelGitDeploymentProvider({
      token: "not-logged",
      projectId: "project",
      fetch: async () =>
        new Response(
          JSON.stringify({
            deployments: [
              {
                uid: "wrong",
                url: "wrong.example.com",
                state: "READY",
                target: "production",
                meta: { githubCommitSha: "a".repeat(64) },
              },
              {
                uid: "right",
                url: "right.example.com",
                state: "READY",
                target: "production",
                meta: { githubCommitSha: sha },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    const x = await provider.getDeploymentStatus({
      publicationId: "publication_aaaaaaaaaaaaaaaaaaaaaaaa",
      commitSha: sha,
    });
    expect(x.deploymentId).toBe("right");
    expect(x.environment).toBe("production");
  });
  it("accepts only exact-commit Vercel-bot Production deployment metadata", async () => {
    const sha = "b".repeat(40),
      requests: string[] = [];
    const provider = new VercelGitHubDeploymentProvider({
      token: "not-logged",
      repository: "owner/repository",
      now: () => new Date("2026-08-09T20:00:00Z"),
      fetch: async (input) => {
        requests.push(String(input));
        return requests.length === 1
          ? new Response(
              JSON.stringify([
                {
                  id: 42,
                  sha,
                  environment: "Production",
                  creator: { login: "vercel[bot]", type: "Bot" },
                },
              ]),
              { status: 200 },
            )
          : new Response(
              JSON.stringify([
                {
                  state: "success",
                  environment: "Production",
                  environment_url: "https://exact.vercel.app",
                },
              ]),
              { status: 200 },
            );
      },
    });
    await expect(
      provider.getDeploymentStatus({
        publicationId: "publication_aaaaaaaaaaaaaaaaaaaaaaaa",
        commitSha: sha,
      }),
    ).resolves.toMatchObject({
      provider: "vercel_git",
      commitSha: sha,
      deploymentId: "42",
      status: "ready",
      environment: "production",
      url: "https://exact.vercel.app",
    });
    expect(requests[0]).toContain(`sha=${sha}`);
    expect(requests[0]).toContain("environment=Production");
  });
  it("sends only publication summaries to Telegram", async () => {
    const adapter = new RecordingTelegramAdapter();
    const notifications = new TelegramPublicationNotifications(adapter, "1");
    await notifications.started({
      title: "Safe title",
      draftVersion: 2,
      publicationId: "publication_aaaaaaaaaaaaaaaaaaaaaaaa",
      scheduled: false,
    });
    expect(JSON.stringify(adapter.calls)).toContain("Safe title");
    expect(JSON.stringify(adapter.calls)).not.toMatch(
      /article body|approvalNotes|telegramUserId/,
    );
  });
});
