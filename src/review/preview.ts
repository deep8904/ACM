import type { ArticleDraftRepository } from "../writing/interfaces";
import { inspectMdx } from "../writing/mdx";
import { sha256 } from "../writing/task";
import type { ReviewConfig } from "./config";
import type {
  DraftPreviewRepository,
  ReviewGateRepository,
} from "./interfaces";
import { draftPreviewSchema } from "./models";

export class PreviewService {
  constructor(
    private deps: {
      drafts: ArticleDraftRepository;
      previews: DraftPreviewRepository;
      gates: ReviewGateRepository;
      config: ReviewConfig;
      clock?: () => Date;
    },
  ) {}
  async create(topicId: string, draftVersion: number) {
    if (!Number.isInteger(draftVersion) || draftVersion < 1)
      throw new Error("An explicit positive draft version is required");
    const draft = await this.deps.drafts.get(topicId, draftVersion);
    const latest = await this.deps.drafts.get(topicId);
    if (
      !draft ||
      draft.status !== "validated" ||
      latest?.version !== draftVersion
    )
      throw new Error("Only the current validated draft can be previewed");
    if (!(await this.deps.gates.topicActive(topicId, draft.approvedEventId)))
      throw new Error("Cancelled drafts cannot be previewed as current");
    const inspection = inspectMdx(draft.mdx, new Set(draft.sourceIds));
    if (inspection.safetyIssues.length)
      throw new Error("Unsafe MDX cannot be previewed");
    const now = (this.deps.clock ?? (() => new Date()))();
    const articleHash = sha256(JSON.stringify(draft));
    const existing = await this.deps.previews.get(topicId, draftVersion);
    if (
      existing?.status === "active" &&
      existing.articleHash === articleHash &&
      Date.parse(existing.expiresAt) > now.getTime()
    )
      return { preview: existing, path: existing.path, reused: true };
    const preview = draftPreviewSchema.parse({
      id: `preview_${sha256(`${draft.id}:${draft.version}`).slice(0, 24)}`,
      topicId,
      draftId: draft.id,
      draftVersion,
      articleHash,
      path: `data/review/previews/${topicId}/draft-v${draftVersion}/preview.html`,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.deps.config.previewExpiryMinutes * 60_000,
      ).toISOString(),
      status: "active",
    });
    const html = render(
      draft.title,
      draft.description,
      draft.mdx,
      draftVersion,
      articleHash,
    );
    const path = await this.deps.previews.save(preview, html);
    return { preview: { ...preview, path }, path, reused: false };
  }
}
function render(
  title: string,
  description: string,
  mdx: string,
  version: number,
  hash: string,
) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escape(title)} — local draft preview</title><style>body{font:18px/1.65 system-ui,sans-serif;max-width:760px;margin:4rem auto;padding:0 1.25rem;color:#14181d;background:#f5f7f9}header{border-bottom:1px solid #ccd2d8;margin-bottom:2rem}pre{white-space:pre-wrap;font:inherit}small{color:#68717c}</style></head><body><header><small>Local private preview · draft v${version} · ${hash.slice(0, 12)}</small><h1>${escape(title)}</h1><p>${escape(description)}</p></header><article><pre>${escape(mdx)}</pre></article></body></html>\n`;
}
function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
