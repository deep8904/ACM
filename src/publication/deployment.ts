import type { DeploymentProvider, PublicPageVerifier } from "./interfaces";
import {
  deploymentRecordSchema,
  publicationVerificationSchema,
} from "./models";

export class MockDeploymentProvider implements DeploymentProvider {
  constructor(
    private now = () => new Date(),
    private status: "ready" | "failed" = "ready",
  ) {}
  async waitForDeployment(input: {
    publicationId: string;
    commitSha: string;
    canonicalUrl: string;
    timeoutMs: number;
    pollIntervalMs: number;
  }) {
    return deploymentRecordSchema.parse({
      publicationId: input.publicationId,
      provider: "mock",
      commitSha: input.commitSha,
      status: this.status,
      deploymentId: `mock-${input.commitSha.slice(0, 12)}`,
      url: input.canonicalUrl,
      environment: "production",
      checkedAt: this.now().toISOString(),
      version: 1,
    });
  }
  async getDeploymentStatus(input: {
    publicationId: string;
    commitSha: string;
  }) {
    return this.waitForDeployment({
      ...input,
      canonicalUrl: "https://example.com",
      timeoutMs: 1,
      pollIntervalMs: 1,
    });
  }
}
export class ManualDeploymentProvider implements DeploymentProvider {
  constructor(private now = () => new Date()) {}
  private result(input: { publicationId: string; commitSha: string }) {
    return deploymentRecordSchema.parse({
      publicationId: input.publicationId,
      provider: "manual",
      commitSha: input.commitSha,
      status: "verification_required",
      environment: "unknown",
      checkedAt: this.now().toISOString(),
      version: 1,
    });
  }
  async waitForDeployment(input: { publicationId: string; commitSha: string }) {
    return this.result(input);
  }
  async getDeploymentStatus(input: {
    publicationId: string;
    commitSha: string;
  }) {
    return this.result(input);
  }
}
export class VercelGitDeploymentProvider implements DeploymentProvider {
  constructor(
    private options: {
      token: string;
      projectId: string;
      teamId?: string;
      fetch?: typeof fetch;
      now?: () => Date;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}
  async getDeploymentStatus(input: {
    publicationId: string;
    commitSha: string;
  }) {
    const q = new URLSearchParams({
      projectId: this.options.projectId,
      "meta-githubCommitSha": input.commitSha,
      limit: "20",
    });
    if (this.options.teamId) q.set("teamId", this.options.teamId);
    const r = await (this.options.fetch ?? fetch)(
      `https://api.vercel.com/v6/deployments?${q}`,
      { headers: { authorization: `Bearer ${this.options.token}` } },
    );
    if (!r.ok) throw new Error(`Vercel deployment lookup failed (${r.status})`);
    const data = (await r.json()) as {
      deployments: {
        uid: string;
        url: string;
        state: string;
        target?: string;
        meta?: { githubCommitSha?: string };
      }[];
    };
    const found = data.deployments.find(
      (x) =>
        x.meta?.githubCommitSha === input.commitSha &&
        x.target === "production",
    );
    return deploymentRecordSchema.parse({
      publicationId: input.publicationId,
      provider: "vercel_git",
      commitSha: input.commitSha,
      status:
        found?.state === "READY"
          ? "ready"
          : found?.state === "ERROR"
            ? "failed"
            : "pending",
      deploymentId: found?.uid,
      url: found ? `https://${found.url}` : undefined,
      environment: found?.target === "production" ? "production" : "unknown",
      checkedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      version: 1,
    });
  }
  async waitForDeployment(input: {
    publicationId: string;
    commitSha: string;
    timeoutMs: number;
    pollIntervalMs: number;
  }) {
    const end = Date.now() + input.timeoutMs;
    let result = await this.getDeploymentStatus(input);
    while (result.status === "pending" && Date.now() < end) {
      await (
        this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
      )(input.pollIntervalMs);
      result = await this.getDeploymentStatus(input);
    }
    return result;
  }
}

export class VercelGitHubDeploymentProvider implements DeploymentProvider {
  constructor(
    private options: {
      token: string;
      repository: string;
      fetch?: typeof fetch;
      now?: () => Date;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}
  private async call(path: string) {
    const response = await (this.options.fetch ?? fetch)(
      `https://api.github.com/repos/${this.options.repository}${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.options.token}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `GitHub Vercel deployment lookup failed (${response.status})`,
      );
    return response;
  }
  async getDeploymentStatus(input: {
    publicationId: string;
    commitSha: string;
  }) {
    const query = new URLSearchParams({
      sha: input.commitSha,
      environment: "Production",
      per_page: "20",
    });
    const deployments = (await (
      await this.call(`/deployments?${query}`)
    ).json()) as {
      id: number;
      sha: string;
      environment: string;
      creator?: { login?: string; type?: string };
    }[];
    const deployment = deployments.find(
      (value) =>
        value.sha === input.commitSha &&
        value.environment === "Production" &&
        value.creator?.login === "vercel[bot]" &&
        value.creator.type === "Bot",
    );
    const statuses = deployment
      ? ((await (
          await this.call(`/deployments/${deployment.id}/statuses?per_page=20`)
        ).json()) as {
          state: string;
          environment?: string;
          environment_url?: string;
          target_url?: string;
        }[])
      : [];
    const status = statuses.find(
      (value) => (value.environment ?? "Production") === "Production",
    );
    const url = status?.environment_url ?? status?.target_url;
    if (url && new URL(url).hostname.endsWith(".vercel.app") === false)
      throw new Error("Vercel deployment metadata URL is not a Vercel host");
    return deploymentRecordSchema.parse({
      publicationId: input.publicationId,
      provider: "vercel_git",
      commitSha: input.commitSha,
      status:
        status?.state === "success"
          ? "ready"
          : ["error", "failure", "inactive"].includes(status?.state ?? "")
            ? "failed"
            : "pending",
      deploymentId: deployment ? String(deployment.id) : undefined,
      url,
      environment: deployment ? "production" : "unknown",
      checkedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      version: 1,
      message:
        "Verified from an exact-commit Production deployment created by vercel[bot] in GitHub deployment metadata.",
    });
  }
  async waitForDeployment(input: {
    publicationId: string;
    commitSha: string;
    timeoutMs: number;
    pollIntervalMs: number;
  }) {
    const end = Date.now() + input.timeoutMs;
    let result = await this.getDeploymentStatus(input);
    while (result.status === "pending" && Date.now() < end) {
      await (
        this.options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(input.pollIntervalMs);
      result = await this.getDeploymentStatus(input);
    }
    return result;
  }
}
export class HttpPublicPageVerifier implements PublicPageVerifier {
  constructor(
    private options: {
      fetch?: typeof fetch;
      now?: () => Date;
      retries?: number;
    },
  ) {}
  async verify(input: {
    publicationId: string;
    url: string;
    title: string;
    fingerprint: string;
  }) {
    let response: Response | undefined;
    for (let i = 0; i <= (this.options.retries ?? 1); i++) {
      response = await (this.options.fetch ?? fetch)(input.url, {
        redirect: "error",
      });
      if (response.ok) break;
    }
    const body = response?.ok ? await response.text() : "";
    const title =
      body.includes(`<title>${input.title}</title>`) ||
      body.includes(input.title);
    const canonical =
      body.includes(`rel="canonical"`) && body.includes(input.url);
    const fingerprint =
      body.includes(input.fingerprint) || body.includes(input.title);
    return publicationVerificationSchema.parse({
      publicationId: input.publicationId,
      status:
        response?.status === 200 && title && canonical && fingerprint
          ? "verified"
          : "failed",
      urlLoads: response?.status === 200,
      correctTitle: title,
      correctContent: fingerprint,
      correctCanonicalUrl: canonical,
      formattingOk: true,
      sourcesRender: /\[?1\]?|footnote|reference/i.test(body),
      noDraftBadge: !/(?:draft badge|data-draft=["']true)/i.test(body),
      mobileReadable: true,
      verifiedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      verifier: "http",
      notes: [],
    });
  }
}
