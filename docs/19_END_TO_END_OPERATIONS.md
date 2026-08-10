# End-to-End Operations

## First-time setup

1. Install Node.js 22 and run `npm ci`.
2. Copy `.env.example` to a private environment file and configure only services in use. Never commit tokens.
3. Review validated examples in `automation/config/`, especially timezone, source allowlists, repository mode, Telegram allowlists, and analytics retention.
4. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
5. Configure Supabase/Postgres using `docs/25_SUPABASE_SETUP.md`. Durable adapters now exist, but production still fails closed unless the Postgres backend connects and migration/table health passes.
6. Run `npm run production:readiness`; do not treat a state beyond the printed evidence as achieved.

Database operator commands:

```bash
npm run db:status
npm run db:migrate
npm run db:verify
npm run production:readiness
npm run storage:migrate -- --from file --to postgres --dry-run
```

## Normal weekly workflow

```text
discovery → deterministic ranking → Telegram topic approval (mandatory)
→ research task/manual result import → validated research packet
→ writing task/manual draft import → deterministic editorial review
→ Telegram final article approval (mandatory, exact draft version/hash)
→ repository publication/deployment verification
→ social task/manual import → per-platform Telegram approval
→ manual export/post confirmation → aggregate analytics import
→ snapshots → deterministic reports/insights → human review
```

No downstream stage may infer either approval. Reject, hold, or revision returns control to the relevant gate. Analytics never creates a topic, article, publication, social post, or approval event.

## Exact commands

Run `npm run` for the canonical list. Main stage commands are:

```bash
npm run discovery
npm run ranking
npm run telegram:webhook
npm run research:prepare -- --topic-id <topicId>
npm run research:import -- --topic-id <topicId> --file <result.json>
npm run write:prepare -- --topic-id <topicId>
npm run write:import -- --topic-id <topicId> --file <article.json>
npm run review:run -- --topic-id <topicId>
npm run publication:run
npm run publication:verify -- --publication-id <publicationId>
npm run social:prepare -- --publication-id <publicationId>
npm run social:import -- --publication-id <publicationId> --file <package.json>
npm run social:export -- --publication-id <publicationId> --platform <platform>
npm run analytics:sync -- --provider publication_records
npm run analytics:import -- --provider manual_csv --file <aggregate.csv>
npm run analytics:snapshot -- --publication-id <publicationId> --period 7d
npm run analytics:insights
npm run analytics:report:weekly
```

Exact Telegram and stage options live in docs 12 and 15–18.

## Automatic and manual responsibilities

Automatic/deterministic: validation, normalization, clustering, scoring, eligibility and quality checks, strict imports, state transitions, repository fixture publication, aggregate calculations, completeness scoring, report generation, idempotency, and audit logs.

Deep must manually approve topics, run Claude Code/Gemini task packets when desired, review/import their files, resolve editorial findings, approve the exact final article in Telegram, authorize production publication, approve social items, post/schedule externally, confirm public post URLs, export aggregate analytics, review insights, and explicitly decide any future strategy change.

## Production blockers

- Local file repositories are not private durable shared storage; Telegram, analytics schedules, and coordinated workers fail closed in production.
- Live Google Search Console authentication is not wired. The injected adapter and manual import path are implemented.
- Vercel has no claimed stable read adapter; use a manual aggregate export.
- Publication/social production credentials and external operations need a separate deployment review.
- There is no protected analytics dashboard; CLI and authorized Telegram are supported.

## Failure recovery, backup, and security

- Provider failure: retry; fixture/raw state is immutable.
- Manual import failure: correct the file against its schema and preserve provenance.
- Telegram failure: restore private state and retry the same signed/versioned action; retain idempotency records.
- Publication failure: inspect the job and verification; never mark published without exact canonical/content verification.
- Social failure: create a new immutable package version and approve again; only public URLs may be marked posted.
- Analytics failure: correct/replay the aggregate export. An unchanged hash is idempotent; missing stays null. Restore corrupt state from backup.

Back up `data/` and `data/tasks/` only to encrypted private storage using a consistent snapshot. Preserve file modes and structure; test restoration in an isolated fixture root. Never expose these trees in public artifacts, reports, or Telegram.

Before launch, confirm webhook/callback secrets and allowlists; exercise both approval gates; confirm no secrets in logs/tasks/reports; retain SSRF and canonical URL checks; verify workflow read permissions, fork guards, concurrency and durable-storage gates; then review `npm audit --omit=dev` and `npm audit --audit-level=high`.

## Final audit and simulation

Milestones 0–9 are the complete implementation roadmap. There is no Milestone 10. The cumulative offline integration suites form the full product simulation: ingestion/ranking, topic approval, research, writing, editorial/final approval, publication/verification, social approval/export/post record, and analytics import/snapshot/report/Telegram summary. They contact no Google, Vercel, social, Telegram, or AI service.

Run the complete ordered fixture-suite simulation with `npm run test:simulation`. It includes every milestone's integration boundary in one offline command and finishes with the Milestone 9 no-mutation audit.

Before launch, run all validation, schema generation, fixture suites, and cleanup dry-run. Confirm earlier artifacts stay unchanged during analytics, ranking configuration is byte-identical, no automatic strategy changes occur, both approvals remain mandatory, production fails closed without durable state, and all reports contain aggregates only.
