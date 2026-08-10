# Milestone 8: Controlled Social Content Pipeline

## Current consolidated workflow

After a verified production publication is created, the configured Telegram chat receives one **Distribute this article** card. The operator toggles LinkedIn, X, Instagram, and Medium, then presses **Prepare selected**. Selection callbacks are HMAC-signed, revision checked, authenticated by the normal Telegram allowlist, and replay-safe. Merely viewing or toggling the card cannot prepare, approve, export, or post anything.

Preparation creates only the selected platform variants. It uses a local deterministic Sharp/SVG renderer, the verified article title, public-safe claim index, canonical URL, and Deep / Loose Thread design tokens. It does not browse, call an image model, use third-party logos, or invent screenshots/product UI. Output sizes are:

- LinkedIn and X card: 1200×627 PNG.
- Instagram carousel: six 1080×1350 PNG slides with per-slide alt text.
- Medium: two 1200×675 PNG section images plus a structured text adaptation.

One `SocialDistributionPlan` tracks selection and consolidated state. Existing immutable `SocialPackage`, `PlatformContentItem`, quality, approval, export, history, and posted records remain underneath for auditability and backward compatibility. One **Confirm selected** action approves every selected quality-passed item. A blocked item prevents bulk confirmation and is the only item surfaced for intervention.

All four live publisher capabilities currently resolve to the `manual` provider. No LinkedIn, X, Meta/Instagram, or Medium official API credentials or adapters are configured. The ready card therefore says **Manual export required** and never says posted. A posted record exists only after an official adapter confirms a real URL or the operator records the real public URL.

```bash
npm run social:distribute -- \
  --publication-id <verifiedProductionPublicationId> \
  --platforms linkedin,instagram

npm run social:distribution:status -- \
  --publication-id <verifiedProductionPublicationId>

npm run social:distribution:confirm -- \
  --publication-id <verifiedProductionPublicationId>

npm run social:distribution:assets -- \
  --publication-id <verifiedProductionPublicationId> \
  --output-dir /absolute/private/export-directory
```

In Telegram, use `/distribute <verifiedProductionPublicationId>` or `/social <topicId>`. The production verification command sends the initial card automatically when the bot and allowed chat IDs are configured.

## Boundary and safety posture

Milestone 8 converts one exact, verified published article into platform-specific social packages. The default consolidated path generates deterministic branded images locally. It never opens a platform session, scrapes a social site, or claims a post without provider confirmation. Live posting remains unavailable because no official API adapter is configured.

Production fails closed unless `STORAGE_BACKEND=postgres`, the server-side connection is configured, and the private schema passes migration and health checks. Local file adapters are fixture/development adapters only. In Postgres mode, draft packages, tasks, approvals, schedules, exports, conversations, and posted records remain in the private `content_machine` schema.

## Architecture and eligibility

`SocialDistributionService` sits above `SocialService` and durable repositories for plans, immutable plan events, binary assets, packages, quality reports, approvals, exports, and posted records. `SocialPublisherRegistry` exposes `canAutoPost`, image, carousel, thread, and draft capabilities and falls back to `ManualSocialPublisher`.

Preparation requires an explicit publication ID. The record must exist, be `published`, be the newest record for its topic/hash, have a production deployment in `ready` state, and resolve its exact repository path and commit. The resolved MDX SHA-256 must equal the publication record hash and contain the canonical URL. Cancelled, superseded, stale, missing, or deployment-unverified records fail before task creation. The published MDX—not research, drafts, Telegram notes, or review state—is the factual source of truth.

## Lifecycle and deterministic preparation

The job moves through claimed/preparing/manual-generation/import/validation/approval states. A single active job is keyed by publication and article hash. Identical preparation and imports are idempotent; modified valid imports create a new immutable package version.

`social:prepare` creates:

```text
data/tasks/social/<publicationId>/v<version>/
  social-generation.md
  social-input.json
  expected-output.schema.json
  platform-rules.json
  claim-index.json
  visual-guidelines.md
  image-prompts.json
```

The compact task contains only public published context, canonical URL, safe claim fingerprints, selected platform rules, brand rules, visual direction, deterministic history warnings, timing suggestions, and the strict output schema. It excludes research bodies, internal claim IDs, local paths, Telegram identifiers, editorial notes, rejected content, and unpublished drafts. `image-prompts.json` is a text-only safety contract; it does not invoke image generation.

## Legacy manual generation workflows

Claude Code:

1. Run `npm run social:prepare -- --publication-id <id> --platforms linkedin,x,instagram,medium`.
2. Open `social-generation.md`; ask Claude Code for only the selected strict JSON package.
3. Save JSON outside Git and run `social:import`.
4. Inspect `social:quality`; review each platform in Telegram.
5. Approve, schedule, revise, hold, or reject separately; then run `social:export`.
6. Copy an approved export into the platform, verify its preview/link, post manually, and use `/mark_posted` or `social:mark-posted`.

Gemini:

1. Prepare the same compact task and upload only `social-input.json`, the schema, rules, and visual guidelines.
2. Request structured JSON only. Visual work is limited to concepts and safe text prompts.
3. Save outside Git, import, validate, and inspect every claim and visual.
4. Approve platforms separately. Generate any image manually only after prompt review; never let Gemini post.

These commands remain compatible for existing packages such as `socialpackage_7e86eb9f4a1a7c11a8d3238f`. They do not rewrite historical approvals or exports. Neither workflow browses unless the operator begins a separate verified workflow.

## Platform behavior

- LinkedIn: one primary post (optional alternate in separate item), recommended 120–250 words, factual opening, short paragraphs, central insight, canonical link, zero to three hashtags, and no engagement bait or unsupported personal experience.
- X: a configurable-length single post and optional four-to-eight-post narrative thread. Validation checks each post, duplicate entries, context loss, certainty, links, and zero-to-two hashtags.
- Instagram: five-to-eight ordered carousel slides plus caption. Every slide has headline, readable body, visual direction, and alt text. Product render or hands-on implications are blocked. “Link in bio” is allowed only when the supplied posting context makes it true.
- Medium: an adaptation plan or optional draft with adapted title/introduction, cuts/expansions, primary-publication disclosure, and canonical guidance. Blind syndication and fake freshness are blocked.

No platform is mandatory. LinkedIn and X are default selections; Instagram and Medium are explicitly selectable. Configuration controls limits, defaults, schedule windows, preview size, similarity thresholds, callback/conversation expiry, revision count, Medium mode, and visual prompts.

## Claims, compression, disclosure, copyright, and visuals

The public-safe claim index maps article sections to task-local fingerprints, claim type, public URLs, and compression permission. Imports must reference known claims and the exact publication hash. Deterministic checks cover names, numbers, dates, versions, URLs, uncertainty terms, non-hands-on disclosure, unsupported certainty, banned hooks, private data, and content limits.

Compression must not turn “may” into “will,” “announced” into “available,” early evidence into proof, or remove regional, price, compatibility, or source-based-review caveats. Source-based LinkedIn/Medium content keeps a short disclosure; X cannot imply testing; Instagram cannot claim possession or “my review” without evidence.

Copy checks measure sentence/phrase/paragraph overlap and introduction duplication. Medium canonical guidance is mandatory. Imported visual briefs declare purpose, composition, aspect ratio, typography, provenance preference, prohibited elements, misinformation risk, and alt text. Image prompts require negative instructions against fake screenshots, fabricated hardware, unauthorized logos, implied possession, misleading renders, and unlicensed third-party screenshots. The legacy prompt/import path generates no image; the consolidated path renders only repository-owned abstract/editorial templates.

## Import, quality, persistence, and versioning

`social:import` strictly rejects unknown fields/platforms, mismatched IDs/hash/task/version/selection, duplicate items, unsafe or tracking URLs, secret patterns, Telegram data, internal paths, private IPs, emails, past schedules, platform-limit failures, missing disclosures, unsupported claims, excessive copy, and unsafe visual instructions. Imported content is data and is never executed.

Each item receives a report containing counts, claim alignment, link validity, hook/repetition/platform-fit/disclosure results, hashtags, emoji, copy similarity, timing, visual risk, blockers, warnings, and `passed`, `passed_with_warnings`, or `blocked`. Validation never means posting approval.

Packages live at `data/social/packages/<publicationId>/vN/`; each directory is immutable and contains the package, quality files, and minimized import provenance. Duplicate imports reuse their version. A changed valid result increments the version. Changed items get new stable content-derived IDs; unchanged item approvals can be explicitly carried to a new package version. Changed-item approvals are not inherited.

Revision tasks live under `data/tasks/social-revision/<publicationId>/package-vN/` and include the instruction, strict schema, source summary, and protected claims. Scopes include LinkedIn, X post/thread, Instagram carousel/caption, Medium, timing only, visual brief only, and full package. Out-of-scope copy changes are blocked and revisions are capped by configuration.

## Telegram review and scheduling

Commands include `/social`, `/social_package`, `/approve_social`, `/schedule_social`, `/changes_social`, `/reject_social`, and `/mark_posted`. Cards contain bounded metadata/previews and signed `s:` callbacks for approve, schedule, changes, hold, reject, text, quality, navigation, and manual-post URL intake. Callback data contains only an action, opaque item suffix, package version, and HMAC; tampered, stale-version, expired, and duplicate callbacks are rejected or handled idempotently.

Changes, rejection reasons, schedule times, approval notes, and post URLs use bounded expiring conversation states; they are not conversational AI. Schedules are exact future instants, stored in UTC with `America/Phoenix` as the default input timezone. Different platforms may have different times. A schedule record and manifest are only operator notes: they do not confirm native scheduling or posting.

## Exports and manual posting

Only approved, scheduled, or manually posted item versions are exported. Formats include LinkedIn text/Markdown/JSON, X post/thread text, Instagram carousel/alt-text/caption/visual metadata, Medium Markdown, and `schedule.json`. Privacy scrub runs before export. Files contain no Telegram metadata, internal IDs, approval notes, research paths, secrets, credentials, private URLs, or hidden tracking parameters.

After the operator posts manually, a validated public platform URL creates a posted record with platform, timestamp, package version, content hash, manual method, and operator-confirmed state. This is the only “live” assertion in Milestone 8. No engagement metrics are scraped.

## CLI and fixture mode

```bash
npm run social:prepare -- --publication-id <id> [--platforms linkedin,x,instagram,medium]
npm run social:status -- --publication-id <id>
npm run social:task -- --publication-id <id>
npm run social:import -- --publication-id <id> --file /absolute/result.json
npm run social:package -- --publication-id <id> [--version N]
npm run social:quality -- --publication-id <id> [--version N]
npm run social:approve -- --publication-id <id> --platform <platform> --version N
npm run social:schedule -- --publication-id <id> --platform <platform> --version N --publish-at <datetime>
npm run social:export -- --publication-id <id> [--version N]
npm run social:mark-posted -- --publication-id <id> --platform <platform> --post-url <url>
npm run social:revise:prepare -- --publication-id <id> --version N --scope <scope>
npm run social:revise:import -- --publication-id <id> --version N --file /absolute/result.json
```

The CLI performs no model or social-network calls, prints summaries rather than full posts, and supports the local publication/blog fixture roots. In production it refuses file-backed private state until durable private adapters are explicitly configured.

## Privacy verification and Milestone 9 stop

Only the exact published article provides substantive content. Research bodies and task paths do not enter packages; Telegram identifiers and private notes do not enter exports; image prompts contain no private material; no platform credentials exist; normal logs do not print full posts. Platform rules and limits can change, so operators must verify the platform preview and policies before posting.

Milestone 8 ends after manual-post confirmation. There are no analytics directories, engagement readers, automated replies, performance-based timing, ranking changes, or autonomous editorial decisions.
