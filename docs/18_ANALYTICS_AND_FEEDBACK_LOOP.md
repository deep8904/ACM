# Analytics and Feedback Loop

## Scope and safety boundary

Milestone 9 adds privacy-safe aggregate analytics after verified publication and manually confirmed social distribution. It does not publish, post, call a model, identify visitors, or change ranking/editorial configuration. Both Telegram topic approval and final article approval remain mandatory upstream gates.

The implementation is CLI-first. `/admin/analytics` is intentionally not implemented because a protected production admin surface would add authentication scope. `dashboardEnabled` is validated as `false`. Production file-backed analytics and Telegram analytics fail closed until a private durable backend exists.

## Sources and semantics

- `publication_records` supplies exact publication, workflow, and distribution facts.
- `manual_csv`, `manual_json`, and `social_manual` import aggregate exports.
- `google_search_console` has a provider-neutral paginated injected-transport adapter suitable for fixtures. Live authentication is not claimed or wired.
- `vercel_web_analytics` declares its limitation and directs operators to manual aggregate export; no unstable or invented API is used.

Every import maps to one exact published `PublicationRecord` by ID or normalized canonical URL. Query strings, fragments, preview/local URLs, ambiguous canonicals, unknown pages, mismatched posted records, negative counts, impossible rates, duplicate rows, formulas, excessive files, and personal/secret fields are rejected. Missing values stay `null`; zero means observed zero. Provider semantics remain distinct: search clicks are not sessions, impressions are not unique visitors, and engagement rates are not assumed equivalent.

## Storage, privacy, and retention

Private local state lives under `data/analytics/`; assisted tasks live under `data/tasks/analytics/`. Imports, metrics, snapshots, reports, insights, decisions, and task packets use strict schemas. Files are atomic and mode `0600`; immutable imports/snapshots/report bundles are content-addressed or exclusive. Report exports include Markdown, JSON, and aggregate CSV.

Never import IP addresses, email addresses, user/account/session/cookie identifiers, Telegram identifiers, full user agents, credentials, private query parameters, article bodies, unpublished notes, or private runtime paths. The privacy scrub runs before normalization, analysis-task creation, advisory import, notes, and report export. Use `npm run analytics:cleanup -- --dry-run`; destructive cleanup additionally requires `--confirm-cleanup yes`.

## Analysis and recommendations

Snapshots support `24h`, `7d`, `28d`, `90d`, and `lifetime`. Derived values are null-safe. Baselines use medians; incomplete windows and insufficient samples are labeled. Insights include evidence, sample size, confidence, limitations, and manual-review status. Suggested experiments define a hypothesis, metric, baseline, duration, sample size, controlled variables, stop condition, ethics, and `requires_manual_review` status.

No insight mutates ranking configuration or editorial policy. Telegram actions persist `reviewed`, `accepted_for_consideration`, `dismissed`, or `note_added`. Acceptance means only that Deep accepted the recommendation for future consideration.

Optional assisted analysis is a manual task/import workflow. Packets contain bounded aggregates, known metric IDs, hashes, and limitations—no article bodies or personal identifiers. There is no model SDK/API call. Imports must match the exact report hash, known publications, and allowed metrics; invented metrics and unsupported causal claims are rejected.

## Commands

```bash
npm run analytics:status
npm run analytics:sync -- --provider publication_records --from 2026-06-01 --to 2026-06-30
npm run analytics:import -- --provider manual_csv --file tests/fixtures/analytics/article-metrics.csv
npm run analytics:import -- --provider social_manual --file tests/fixtures/analytics/social-metrics.json
npm run analytics:article -- --publication-id publication_<24-hex>
npm run analytics:social -- --publication-id publication_<24-hex>
npm run analytics:snapshot -- --publication-id publication_<24-hex> --period 7d
npm run analytics:insights
npm run analytics:report:weekly
npm run analytics:report:monthly
npm run analytics:report -- --from 2026-06-01 --to 2026-06-30
npm run analytics:analysis:prepare -- --report-id report_<24-hex>
npm run analytics:analysis:import -- --report-id report_<24-hex> --file advisory.json
npm run analytics:export -- --report-id report_<24-hex>
npm run analytics:cleanup -- --dry-run
```

The analytics CLI accepts `--fixtures <private-fixture-state-root>`. Article field names are defined by `src/analytics/importer.ts`; use `tests/fixtures/analytics/article-metrics.csv` as a template. Social imports require an exact confirmed public post URL; use `tests/fixtures/analytics/social-metrics.json` as a template.

## Telegram and scheduling

Authorized operators can use `/analytics`, `/analytics_week`, `/analytics_month`, `/article_stats <topicId>`, `/social_stats <topicId>`, `/top_articles`, `/editorial_insights`, `/data_status`, and `/insight_note <insightId> <note>`. Responses are bounded aggregate summaries. Insight buttons are signed and versioned. No visitor-level information or Telegram metadata enters analytics storage.

The weekly/monthly GitHub examples are manual-dispatch only, read-only, fork-guarded, concurrency-controlled, and gated by `ENABLE_ANALYTICS_WORKFLOW` plus verified `STORAGE_BACKEND=postgres` configuration. They run database verification and the readiness checklist before analytics. They remain examples and are not automatically enabled. Retry a corrected import safely; unchanged import hashes are idempotent. Invalid database state fails loudly and must be restored from a private backup.
