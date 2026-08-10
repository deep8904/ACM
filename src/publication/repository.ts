import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { writeAtomicJson } from "../discovery/persistence";
import type { ContentRepository, RepositoryCommit } from "./interfaces";
import { digest } from "./transform";

interface FixtureState {
  refs: Record<string, string>;
  commits: Record<
    string,
    {
      commit: RepositoryCommit;
      message: string;
      files: { path: string; contentHash: string }[];
      idempotencyKey: string;
    }
  >;
}
const empty = (): FixtureState => ({
  refs: { main: "0".repeat(64) },
  commits: {},
});
export class LocalContentRepository implements ContentRepository {
  constructor(
    private root: string,
    private defaultBranch = "main",
  ) {}
  private statePath() {
    return join(this.root, ".fixture-git", "state.json");
  }
  private async state() {
    try {
      return JSON.parse(
        await readFile(this.statePath(), "utf8"),
      ) as FixtureState;
    } catch (e) {
      if (
        e instanceof Error &&
        "code" in e &&
        (e as NodeJS.ErrnoException).code === "ENOENT"
      )
        return empty();
      throw e;
    }
  }
  async getDefaultBranch() {
    return this.defaultBranch;
  }
  async getFile(path: string) {
    try {
      const content = await readFile(join(this.root, path), "utf8");
      return { path, content, sha: digest(content) };
    } catch (e) {
      if (
        e instanceof Error &&
        "code" in e &&
        (e as NodeJS.ErrnoException).code === "ENOENT"
      )
        return null;
      throw e;
    }
  }
  async findCaseInsensitiveFile(path: string) {
    try {
      const expected = basename(path).toLowerCase();
      const name = (await readdir(join(this.root, dirname(path)))).find(
        (entry) => entry.toLowerCase() === expected,
      );
      return name ? this.getFile(posix.join(posix.dirname(path), name)) : null;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return null;
      throw error;
    }
  }
  async createBranch(name: string, baseSha: string) {
    const s = await this.state();
    if (s.refs[name] && s.refs[name] !== baseSha)
      throw new Error("Branch conflict");
    s.refs[name] = baseSha;
    await writeAtomicJson(this.statePath(), s);
  }
  async createCommit(input: {
    branch: string;
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
    idempotencyKey: string;
  }) {
    const s = await this.state();
    const found = Object.values(s.commits).find(
      (x) => x.idempotencyKey === input.idempotencyKey,
    );
    if (found) return found.commit;
    const parent = s.refs[input.branch] ?? s.refs[this.defaultBranch];
    if (parent !== input.expectedParentSha)
      throw new Error("Optimistic repository conflict");
    const sha = digest(
      JSON.stringify({
        parent,
        message: input.message,
        files: input.files.map((x) => [x.path, digest(x.content)]),
      }),
    );
    for (const file of input.files) {
      await mkdir(dirname(join(this.root, file.path)), { recursive: true });
      await writeFile(join(this.root, file.path), file.content, {
        encoding: "utf8",
        mode: 0o644,
      });
    }
    const commit = { sha, parentSha: parent, branch: input.branch };
    s.commits[sha] = {
      commit,
      message: input.message,
      files: input.files.map((x) => ({
        path: x.path,
        contentHash: digest(x.content),
      })),
      idempotencyKey: input.idempotencyKey,
    };
    s.refs[input.branch] = sha;
    await writeAtomicJson(this.statePath(), s);
    return commit;
  }
  async createCommitOnNewBranch(input: {
    branch: string;
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
    idempotencyKey: string;
  }) {
    const s = await this.state();
    const found = Object.values(s.commits).find(
      (x) => x.idempotencyKey === input.idempotencyKey,
    );
    if (found) return found.commit;
    if (s.refs[input.branch]) throw new Error("Branch conflict");
    if (s.refs[this.defaultBranch] !== input.expectedParentSha)
      throw new Error("Optimistic repository conflict");
    const sha = digest(
      JSON.stringify({
        parent: input.expectedParentSha,
        message: input.message,
        files: input.files.map((x) => [x.path, digest(x.content)]),
      }),
    );
    for (const file of input.files) {
      await mkdir(dirname(join(this.root, file.path)), { recursive: true });
      await writeFile(join(this.root, file.path), file.content, {
        encoding: "utf8",
        mode: 0o644,
      });
    }
    const commit = {
      sha,
      parentSha: input.expectedParentSha,
      branch: input.branch,
    };
    s.commits[sha] = {
      commit,
      message: input.message,
      files: input.files.map((x) => ({
        path: x.path,
        contentHash: digest(x.content),
      })),
      idempotencyKey: input.idempotencyKey,
    };
    s.refs[input.branch] = sha;
    await writeAtomicJson(this.statePath(), s);
    return commit;
  }
  async updateRef(branch: string, sha: string, expected: string) {
    const s = await this.state();
    if (s.refs[branch] !== expected) throw new Error("Ref conflict");
    s.refs[branch] = sha;
    await writeAtomicJson(this.statePath(), s);
  }
  async getCommit(value: string) {
    const s = await this.state();
    const ref = s.refs[value];
    if (ref)
      return (
        s.commits[ref]?.commit ?? { sha: ref, parentSha: ref, branch: value }
      );
    return (
      s.commits[value]?.commit ??
      Object.values(s.commits).find((x) => x.idempotencyKey === value)
        ?.commit ??
      null
    );
  }
  async isAncestor(ancestorSha: string, descendantSha: string) {
    if (ancestorSha === descendantSha) return true;
    const s = await this.state();
    const seen = new Set<string>();
    let current = descendantSha;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = s.commits[current]?.commit.parentSha;
      if (!parent) return false;
      if (parent === ancestorSha) return true;
      current = parent;
    }
    return false;
  }
}

export class GitHubContentRepository implements ContentRepository {
  constructor(
    private options: {
      token: string;
      repository: string;
      defaultBranch: string;
      fetch?: typeof fetch;
      sleep?: (milliseconds: number) => Promise<void>;
    },
  ) {}
  private async call(path: string, init?: RequestInit) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await (this.options.fetch ?? fetch)(
          `https://api.github.com/repos/${this.options.repository}${path}`,
          {
            ...init,
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${this.options.token}`,
              "x-github-api-version": "2022-11-28",
              ...init?.headers,
            },
          },
        );
        if (![408, 429].includes(response.status) && response.status < 500)
          return response;
        if (attempt === 2) return response;
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
      }
      await (
        this.options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)))
      )(100 * 2 ** attempt);
    }
    throw lastError ?? new Error("GitHub request failed");
  }
  async getDefaultBranch() {
    return this.options.defaultBranch;
  }
  async getFile(path: string, ref = this.options.defaultBranch) {
    const r = await this.call(
      `/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}?ref=${encodeURIComponent(ref)}`,
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub file lookup failed (${r.status})`);
    const x = (await r.json()) as { content: string; sha: string };
    return {
      path,
      content: Buffer.from(x.content, "base64").toString("utf8"),
      sha: x.sha,
    };
  }
  async findCaseInsensitiveFile(
    path: string,
    ref = this.options.defaultBranch,
  ) {
    const directory = posix.dirname(path);
    const r = await this.call(
      `/contents/${encodeURIComponent(directory).replaceAll("%2F", "/")}?ref=${encodeURIComponent(ref)}`,
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub directory lookup failed (${r.status})`);
    const entries = (await r.json()) as { name: string; path: string }[];
    const found = entries.find(
      (entry) =>
        entry.name.toLowerCase() === posix.basename(path).toLowerCase(),
    );
    return found ? this.getFile(found.path, ref) : null;
  }
  async createBranch(name: string, baseSha: string) {
    const r = await this.call("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha: baseSha }),
    });
    if (!r.ok && r.status !== 422)
      throw new Error(`GitHub branch creation failed (${r.status})`);
  }
  async createCommit(input: {
    branch: string;
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
    idempotencyKey: string;
  }) {
    const c = await this.createGitCommit(input);
    await this.updateRef(input.branch, c.sha, input.expectedParentSha);
    return {
      sha: c.sha,
      parentSha: input.expectedParentSha,
      branch: input.branch,
      url: c.html_url,
    };
  }
  async createCommitOnNewBranch(input: {
    branch: string;
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
    idempotencyKey: string;
  }) {
    const c = await this.createGitCommit(input);
    const ref = await this.call("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: c.sha }),
    });
    if (!ref.ok)
      throw new Error(`GitHub branch creation failed (${ref.status})`);
    return {
      sha: c.sha,
      parentSha: input.expectedParentSha,
      branch: input.branch,
      url: c.html_url,
    };
  }
  private async createGitCommit(input: {
    expectedParentSha: string;
    message: string;
    files: { path: string; content: string }[];
  }) {
    const parentResponse = await this.call(
      `/git/commits/${encodeURIComponent(input.expectedParentSha)}`,
    );
    if (!parentResponse.ok)
      throw new Error(`GitHub parent lookup failed (${parentResponse.status})`);
    const parent = (await parentResponse.json()) as { tree: { sha: string } };
    const blobs = [];
    for (const f of input.files) {
      const r = await this.call("/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
      });
      if (!r.ok) throw new Error(`GitHub blob creation failed (${r.status})`);
      blobs.push({
        path: f.path,
        mode: "100644",
        type: "blob",
        sha: ((await r.json()) as { sha: string }).sha,
      });
    }
    const tree = await this.call("/git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: blobs }),
    });
    if (!tree.ok)
      throw new Error(`GitHub tree creation failed (${tree.status})`);
    const tr = (await tree.json()) as { sha: string };
    const commit = await this.call("/git/commits", {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: tr.sha,
        parents: [input.expectedParentSha],
      }),
    });
    if (!commit.ok)
      throw new Error(`GitHub commit creation failed (${commit.status})`);
    return (await commit.json()) as { sha: string; html_url: string };
  }
  async updateRef(branch: string, sha: string, expected: string) {
    void expected;
    const r = await this.call(`/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha, force: false }),
    });
    if (!r.ok) throw new Error(`GitHub ref update failed (${r.status})`);
  }
  async getCommit(shaOrBranch: string) {
    let sha = shaOrBranch;
    if (shaOrBranch.includes("/")) {
      const ref = await this.call(
        `/git/ref/heads/${shaOrBranch
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`,
      );
      if (ref.status === 404) return null;
      if (!ref.ok) throw new Error(`GitHub ref lookup failed (${ref.status})`);
      sha = ((await ref.json()) as { object: { sha: string } }).object.sha;
    }
    const r = await this.call(`/commits/${encodeURIComponent(sha)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub commit lookup failed (${r.status})`);
    const c = (await r.json()) as {
      sha: string;
      parents: { sha: string }[];
      html_url: string;
    };
    return {
      sha: c.sha,
      parentSha: c.parents[0]?.sha ?? "0".repeat(64),
      branch: this.options.defaultBranch,
      url: c.html_url,
    };
  }
  async isAncestor(ancestorSha: string, descendantSha: string) {
    if (ancestorSha === descendantSha) return true;
    const r = await this.call(
      `/compare/${encodeURIComponent(ancestorSha)}...${encodeURIComponent(descendantSha)}`,
    );
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`GitHub commit comparison failed (${r.status})`);
    const comparison = (await r.json()) as { status?: string };
    return comparison.status === "ahead" || comparison.status === "identical";
  }
}
