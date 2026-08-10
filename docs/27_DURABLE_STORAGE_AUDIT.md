# Durable Storage Implementation Audit

Local runtime status at code completion: `DATABASE_CODE_READY` because no server-side connection URL is configured in the process environment. Through the authenticated Supabase connector, migrations 001–011 were applied to the selected project and the 60-table private schema plus the checksummed application migration ledger were verified. Repository parity, staging, and production enablement remain separate evidence-based states.

| Family                                                                          | File implementation | Postgres implementation                      | Offline test | Postgres test      | Production composition            | Status                          |
| ------------------------------------------------------------------------------- | ------------------- | -------------------------------------------- | ------------ | ------------------ | --------------------------------- | ------------------------------- |
| Ranking history/catalog/artifacts                                               | retained            | history, catalog, workflow artifact adapters | legacy suite | schema/simulation  | wired                             | `IMPLEMENTED_NOT_LIVE_VERIFIED` |
| Telegram topic approval/dedupe/conversation/outbox                              | retained            | `PostgresTopicApprovalRepository`            | legacy suite | parity/concurrency | wired, transactional decision     | `IMPLEMENTED_NOT_LIVE_VERIFIED` |
| Research jobs/sources/cache/packets/tasks/events                                | retained            | six durable adapters                         | legacy suite | recovery/schema    | wired                             | `IMPLEMENTED_NOT_LIVE_VERIFIED` |
| Writing jobs/drafts/quality/history/tasks/gates                                 | retained            | six durable adapters                         | legacy suite | migration/schema   | wired                             | `IMPLEMENTED_NOT_LIVE_VERIFIED` |
| Review/issues/tasks/revisions/previews/final approval/outbox                    | retained            | ten durable adapters/views                   | legacy suite | migration/schema   | wired, transactional final outbox | `IMPLEMENTED_NOT_LIVE_VERIFIED` |
| Publication jobs/records/consumption/deployment/verification                    | retained            | six durable adapters/views                   | legacy suite | recovery/schema    | wired                             | `IMPLEMENTED_NOT_LIVE_VERIFIED` |
| Social jobs/packages/items/quality/approval/export/posted/revision/conversation | retained            | ten durable adapters/views                   | legacy suite | migration/schema   | wired; posting remains manual     | `IMPLEMENTED_NOT_LIVE_VERIFIED` |
| Analytics source/sync/metrics/snapshots/insights/actions/reports/import/tasks   | retained            | eleven durable adapters/views                | legacy suite | migration/schema   | wired                             | `IMPLEMENTED_NOT_LIVE_VERIFIED` |

Audit totals: 53 explicit persistent interfaces/catalogs, two direct artifact families, 52 exported Postgres adapter/view classes, 11 migrations, and 60 tables including migration/utility tables. `ContentRepository` and `PublishedArticleContentRepository` deliberately remain the separate public Git boundary, not private workflow-state exceptions.

No production-required stage CLI selects file repositories when `NODE_ENV=production`: configuration requires `STORAGE_BACKEND=postgres`, a real server-side URL, current checksummed migrations, critical tables, and database health. Telegram verifies the same capability before accepting its first webhook request. This is code-level wiring, not evidence that Deep's real project has passed it.

## Test classification

- Offline configuration/migration tests: implemented and run in the normal suite.
- Postgres parity/concurrency/recovery/schema simulation: implemented, automatically skipped without `TEST_DATABASE_URL`, and therefore `IMPLEMENTED_NOT_LIVE_VERIFIED` until run against disposable Postgres.
- Full semantic parity for every individual method and a complete data-bearing lifecycle simulation: `DEFERRED_WITH_REASON` if the conditional suites have not been run against a test database; production cannot advance to `DATABASE_PARITY_VERIFIED` without that evidence.
- Real Supabase schema, privilege, migration-ledger, security-advisor, and performance-advisor inspection: completed through the authenticated connector; unresolved decisions are listed below.

## Live Supabase verification on 2026-08-07

- `IMPLEMENTED`: all 11 ordered migrations applied successfully; `content_machine.schema_migrations` contains matching names and SHA-256 checksums through version 011.
- `IMPLEMENTED`: 60 `content_machine` tables exist and are empty before file-state migration.
- `IMPLEMENTED`: live privilege queries show `anon`, `authenticated`, and `service_role` have no `USAGE`, `SELECT`, or `INSERT` access to the private schema/table sample. The schema must still remain absent from Supabase's exposed Data API schema configuration.
- `MANUAL_ACCOUNT_ACTION_REQUIRED`: Supabase emits a generic critical RLS-disabled advisory for all 60 tables. RLS was not enabled automatically because the advisor explicitly requires an operator policy decision and the schema is designed for direct trusted-server Postgres access with browser roles revoked.
- `BLOCKED`: Supabase reports that the pre-existing `public.rls_auto_enable()` security-definer function is executable by `anon` and `authenticated`. It is outside this repository's migrations; Deep must identify its owner/purpose before revoking or changing it.
- `IMPLEMENTED`: the repository-owned mutable-function-search-path warning and six unindexed foreign-key warnings were fixed by migration 011. Remaining performance notices are expected unused-index notices on an empty database.
