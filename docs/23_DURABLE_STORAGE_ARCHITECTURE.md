# Durable Storage Architecture

Status: design source of truth for the file-to-Postgres migration. This document describes implemented repository contracts as audited on 2026-08-07; it does not claim that a Supabase database has been connected or migrated.

## Safety boundary

Production private workflow state belongs in the dedicated `content_machine` Postgres schema. `content_machine` **MUST NOT be added to Supabase's exposed browser/Data API schemas**. Database URLs, passwords, and service-role credentials are server-only and must never use a `NEXT_PUBLIC_*` name. Public article content remains in the separate Git content repository; Telegram tokens and other provider credentials remain environment secrets, never database rows.

The application retains every `File*Repository` for development, fixtures, offline simulation, recovery comparison, and migration input. Production must fail closed unless it selects the Postgres composition and verifies the database capability and migration version. A boolean readiness flag is not evidence of durability.

## Audit method and scope

The audit covered `src/config`, `src/discovery`, `src/ranking`, `src/telegram`, `src/research`, `src/writing`, `src/review`, `src/publication`, `src/social`, and `src/analytics`, including every repository interface and file implementation. The machine-readable companion is `database/repository-inventory.json`.

Sensitivity labels: **private** means workflow/operator data; **restricted** means content or provenance that may include externally obtained text or operational metadata; **public-boundary** means the adapter deliberately targets the separate public Git repository; **aggregate-only** means analytics may not contain visitor-level personal data.

## Repository inventory

| Interface                              | Current file implementation                          | Data                                                                             | Sensitivity     | Transaction requirements                                              | Postgres replacement                                   |
| -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| `HistoryRepository`                    | `FileHistoryRepository`                              | Ranking history snapshots                                                        | private         | Append one immutable run; deterministic list                          | `PostgresHistoryRepository`                            |
| `TopicCatalog`                         | `FileTopicCatalog`                                   | Ranked run/topic lookup                                                          | private         | Stable run and topic identity                                         | `PostgresTopicCatalog`                                 |
| `TopicApprovalRepository`              | `FileTelegramRepository`                             | Queue, approvals, Telegram dedupe, conversations, message index, approved events | private         | CAS versions; unique update/callback; approval plus outbox atomically | `PostgresTopicApprovalRepository`                      |
| `ResearchJobRepository`                | `FileResearchJobRepository`                          | Research job state and leases                                                    | private         | Atomic claim, stale recovery, attempts/version                        | `PostgresResearchJobRepository`                        |
| `ResearchSourceRepository`             | `FileResearchSourceRepository`                       | Source metadata and bounded extracted text                                       | restricted      | Source identity/content hash uniqueness                               | `PostgresResearchSourceRepository`                     |
| `ResearchPacketRepository`             | `FileResearchPacketRepository`                       | Immutable packet versions                                                        | restricted      | Atomic next version; insert-only                                      | `PostgresResearchPacketRepository`                     |
| `ResearchCacheRepository`              | `FileResearchCacheRepository`                        | Fetch/robots cache                                                               | restricted      | URL-keyed upsert with expiry                                          | `PostgresResearchCacheRepository`                      |
| `ResearchTaskRepository`               | `FileResearchTaskRepository`                         | Private assisted-research task/input                                             | restricted      | Atomic task write; stable packet version                              | `PostgresResearchTaskRepository`                       |
| `ApprovedEventRepository`              | `FileApprovedEventRepository`                        | Topic-approved event claim/consumption                                           | private         | Atomic lease; consume only after packet exists                        | `PostgresApprovedEventRepository`                      |
| `WritingJobRepository`                 | `FileWritingJobRepository`                           | Writing job state and leases                                                     | private         | Atomic claim and optimistic state                                     | `PostgresWritingJobRepository`                         |
| `ArticleDraftRepository`               | `FileArticleDraftRepository`                         | Immutable draft, MDX/plain text, provenance                                      | restricted      | Unique topic/version and import hash; bundle atomic                   | `PostgresArticleDraftRepository`                       |
| `DraftQualityRepository`               | draft bundle in `FileArticleDraftRepository`         | Deterministic quality report                                                     | private         | Same transaction as draft                                             | `PostgresDraftQualityRepository`                       |
| `ArticleHistoryRepository`             | `FileArticleHistoryRepository`                       | Article lifecycle entries                                                        | private         | Ordered append, duplicate-safe                                        | `PostgresArticleHistoryRepository`                     |
| `WritingTaskRepository`                | `FileWritingTaskRepository`                          | Private assisted-writing task/input                                              | restricted      | Atomic task write; stable input                                       | `PostgresWritingTaskRepository`                        |
| `WritingGateRepository`                | `FileWritingGateRepository`                          | Approved-event/packet/quality gate views                                         | private         | Consistent exact-version reads                                        | `PostgresWritingGateRepository`                        |
| `EditorialReviewJobRepository`         | `FileEditorialReviewJobRepository`                   | Review job state and leases                                                      | private         | Atomic claim and stale recovery                                       | `PostgresEditorialReviewJobRepository`                 |
| `EditorialReviewRepository`            | `FileEditorialReviewRepository`                      | Immutable reviews, deterministic findings, provenance, resolution mutation       | private         | Unique import/version; review insert atomic; resolution CAS           | `PostgresEditorialReviewRepository`                    |
| `EditorialIssueRepository`             | view in `FileEditorialReviewRepository`              | Issues and resolution state                                                      | private         | Consistent review/version list                                        | `PostgresEditorialIssueRepository`                     |
| `ReviewTaskRepository`                 | `FileReviewTaskRepository`                           | Private assisted-review task/input                                               | restricted      | Atomic task write                                                     | `PostgresReviewTaskRepository`                         |
| `RevisionTaskRepository`               | `FileRevisionTaskRepository`                         | Revision task, request, resolution                                               | restricted      | Request/resolution idempotency and exact lineage                      | `PostgresRevisionTaskRepository`                       |
| `FinalApprovalRepository`              | `FileFinalApprovalRepository`                        | Exact draft/review approvals                                                     | private         | Stale callback rejection; once-only identity                          | `PostgresFinalApprovalRepository`                      |
| `FinalApprovedEventRepository`         | `FileFinalApprovedEventRepository`                   | Immutable approval snapshot/outbox state                                         | private         | Approval plus event atomically; state CAS                             | `PostgresFinalApprovedEventRepository`                 |
| `DraftPreviewRepository`               | `FileDraftPreviewRepository`                         | Telegram preview metadata                                                        | private         | Supersede previous preview consistently                               | `PostgresDraftPreviewRepository`                       |
| `FinalConversationRepository`          | `FileFinalConversationRepository`                    | Expiring Telegram final-review conversation                                      | private         | Actor/chat scoped upsert/delete and expiry                            | `PostgresFinalConversationRepository`                  |
| `ReviewGateRepository`                 | `FileReviewGateRepository`                           | Draft/quality/topic gate views                                                   | private         | Consistent exact-version reads                                        | `PostgresReviewGateRepository`                         |
| `ContentRepository`                    | `LocalContentRepository` / `GitHubContentRepository` | Public article files and commits                                                 | public-boundary | Git commit idempotency; remains provider-neutral                      | Not a private Postgres repository                      |
| `PublicationJobRepository`             | `FilePublicationJobRepository`                       | Publication job leases/status                                                    | private         | Atomic claim; stale recovery                                          | `PostgresPublicationJobRepository`                     |
| `PublicationRepository`                | `FilePublicationRepository`                          | Publication identity, commit SHA, canonical URL                                  | private         | Unique approved event and canonical publication                       | `PostgresPublicationRepository`                        |
| `FinalApprovedEventConsumerRepository` | `FileEventConsumerRepository`                        | Publication consumption receipt                                                  | private         | One receipt per event after success policy                            | `PostgresEventConsumerRepository`                      |
| `DeploymentStatusRepository`           | `FileDeploymentStatusRepository`                     | Exact commit deployment state                                                    | private         | Commit-keyed upsert/version                                           | `PostgresDeploymentStatusRepository`                   |
| `PublicationVerificationRepository`    | `FilePublicationVerificationRepository`              | Canonical/SEO verification                                                       | private         | Publication-keyed upsert/version                                      | `PostgresPublicationVerificationRepository`            |
| `FinalApprovedEventSource`             | file review event source                             | Due final-approved events                                                        | private         | Stable due ordering and claim visibility                              | Postgres view over final-approved events               |
| `PublishedArticleContentRepository`    | content adapter over public files                    | Published article snapshot for social                                            | public-boundary | Exact publication/content hash read                                   | Existing content adapter; Postgres publication lineage |
| `SocialGenerationJobRepository`        | `FileSocialJobRepository`                            | Social generation job/lease state                                                | private         | Atomic claim and recovery                                             | `PostgresSocialGenerationJobRepository`                |
| `SocialPackageRepository`              | `FileSocialPackageRepository`                        | Immutable package versions/platform items/provenance                             | restricted      | Unique publication/version and import hash; bundle atomic             | `PostgresSocialPackageRepository`                      |
| `SocialQualityRepository`              | `FileSocialQualityRepository`                        | Package quality report                                                           | private         | Same transaction as package                                           | `PostgresSocialQualityRepository`                      |
| `SocialApprovalRepository`             | `FileSocialApprovalRepository`                       | Exact item/package approvals and schedules                                       | private         | Exact content hash/version; changed item invalidates                  | `PostgresSocialApprovalRepository`                     |
| `SocialHistoryRepository`              | `FileSocialHistoryRepository`                        | Social lifecycle entries                                                         | private         | Ordered duplicate-safe append                                         | `PostgresSocialHistoryRepository`                      |
| `SocialExportRepository`               | `FileSocialExportRepository`                         | Private export payload/metadata                                                  | restricted      | Immutable export identity                                             | `PostgresSocialExportRepository`                       |
| `SocialTaskRepository`                 | `FileSocialTaskRepository`                           | Assisted-generation task/input                                                   | restricted      | Atomic task write                                                     | `PostgresSocialTaskRepository`                         |
| `SocialPostedRepository`               | `FileSocialPostedRepository`                         | Manual posted receipts/URLs                                                      | private         | Unique record and URL where present                                   | `PostgresSocialPostedRepository`                       |
| `SocialRevisionRepository`             | `FileSocialRevisionRepository`                       | Social revision tasks/results                                                    | restricted      | Exact package/item lineage                                            | `PostgresSocialRevisionRepository`                     |
| `SocialConversationRepository`         | `FileSocialConversationRepository`                   | Expiring Telegram social conversation                                            | private         | Actor/chat scoped upsert/delete and expiry                            | `PostgresSocialConversationRepository`                 |
| `PublicationAnalyticsSource`           | publication repository adapter                       | Published article identities                                                     | private         | Consistent publication snapshot                                       | Postgres publication view                              |
| `AnalyticsSourceRepository`            | `FileAnalyticsSourceRepository`                      | Aggregate analytics source config                                                | private         | Source ID upsert                                                      | `PostgresAnalyticsSourceRepository`                    |
| `AnalyticsSyncJobRepository`           | `FileAnalyticsSyncJobRepository`                     | Sync jobs/status                                                                 | private         | Claim/version/idempotent completion                                   | `PostgresAnalyticsSyncJobRepository`                   |
| `ArticleMetricsRepository`             | `FileArticleMetricsRepository`                       | Aggregate article observations                                                   | aggregate-only  | Idempotent batch; null distinct from zero                             | `PostgresArticleMetricsRepository`                     |
| `SocialMetricsRepository`              | `FileSocialMetricsRepository`                        | Aggregate social observations                                                    | aggregate-only  | Idempotent batch; null distinct from zero                             | `PostgresSocialMetricsRepository`                      |
| `PerformanceSnapshotRepository`        | `FilePerformanceSnapshotRepository`                  | Immutable aggregate snapshots                                                    | aggregate-only  | Insert-only unique snapshot identity                                  | `PostgresPerformanceSnapshotRepository`                |
| `EditorialInsightRepository`           | `FileEditorialInsightRepository`                     | Insights and operator action ledger                                              | private         | Immutable insight; action append/upsert rules                         | `PostgresEditorialInsightRepository`                   |
| `EditorialReportRepository`            | `FileEditorialReportRepository`                      | Immutable JSON/Markdown reports                                                  | aggregate-only  | Unique report identity; insert-only                                   | `PostgresEditorialReportRepository`                    |
| `AnalyticsImportRepository`            | `FileAnalyticsImportRepository`                      | Import hash/provenance ledger                                                    | private         | Unique content hash; retention deletion explicit                      | `PostgresAnalyticsImportRepository`                    |
| `AnalyticsTaskRepository`              | `FileAnalyticsTaskRepository`                        | Analysis task/input/result provenance                                            | restricted      | Atomic task/result writes                                             | `PostgresAnalyticsTaskRepository`                      |
| Discovery run artifact family          | direct files under run directory                     | Normalized source items and discovery manifest                                   | private         | One immutable artifact per run/name                                   | `PostgresWorkflowArtifactRepository`                   |
| Ranking run artifact family            | direct files under run directory                     | Clusters, scored topics, shortlist                                               | private         | One immutable artifact per run/name; topic identity                   | `PostgresWorkflowArtifactRepository` plus topic tables |

There are 53 explicit persistence-facing interfaces/catalogs and two additional direct-file artifact families, for 55 audited storage concerns. Some interfaces are deliberately implemented as consistent views over the same underlying tables rather than independent storage tables. This avoids duplicating state while retaining existing business contracts.

## Relational model

The schema is normalized around stable identities and lineage:

```text
workflow run/topic
  -> topic approval + transactional approved-event outbox
  -> research packet version
  -> article draft version + quality
  -> editorial review version + issues
  -> exact final approval + transactional final-approved-event outbox
  -> publication + commit/deployment/verification
  -> social package version + item approvals/posted receipts
  -> aggregate metrics -> immutable snapshots/reports/insights
```

Stable keys, statuses, versions, content hashes, import hashes, idempotency keys, leases, timestamps, and lineage references are first-class relational columns with constraints. Canonical validated domain documents are also retained in bounded `jsonb` payload columns because the existing Zod models evolve and include nested editorial structures. JSONB does not replace relational identity or integrity. Nested rows with independent access or invariants—editorial issues, social platform items, metric observations, and insight actions—are normalized.

Immutable domain versions are insert-only. Mutable orchestration status and lease state live in separate job/event rows with an integer optimistic version. Database triggers reject updates/deletes to immutable tables outside a migration/restore procedure.

## Transaction boundaries

- Topic approval locks the queue row, checks the expected version, writes the approval, and inserts the approved-event outbox row in one short transaction.
- Claims use a single transaction and `FOR UPDATE SKIP LOCKED`, recording worker, claimed/heartbeat/expiry timestamps, attempts, and version. Expired leases are reclaimable; active leases are not.
- Research completion persists an immutable packet before consuming its approved event. Re-entry locates the existing import hash/version and completes consumption without duplicating the packet.
- Draft and quality/provenance rows commit together. Review, deterministic findings, issues, and provenance commit together.
- Final approval and its immutable final-approved-event snapshot commit together after locking and verifying exact draft/review lineage.
- Publication uses a unique approved-event key and stores a deterministic idempotency key. A retry reconciles an already-created Git commit before advancing database state.
- Social package/items/quality/provenance commit together. Approvals reference exact item content hashes.
- Metric batches and their import ledger commit together; snapshots and reports are independently immutable and duplicate-safe.

Transactions remain short and never hold locks across Telegram, GitHub, Vercel, or other network calls.

## Claim and concurrency strategy

Job and outbox rows use `worker_id`, `claimed_at`, `heartbeat_at`, `lease_expires_at`, `attempt_count`, and `version`. Claimers select eligible rows with `FOR UPDATE SKIP LOCKED`, update the winner in the same transaction, and return the claimed document. Optimistic writes include the expected version in the `WHERE` clause and fail with the existing domain conflict behavior if no row matches. Unique constraints—not preliminary application reads—are the final idempotency authority.

## Artifact strategy

At the current one-operator scale, bounded research text, task packets, MDX, plain text, previews, report Markdown, and social exports are stored privately in Postgres. This avoids adding object-storage credentials, lifecycle rules, and recovery paths before size requires them. Each artifact has a media type, byte length, SHA-256 hash, and bounded content. The provider-neutral artifact repository boundary permits later migration to a private object store without changing workflow services. No public/signed artifact URLs are needed initially.

Public article files are the exception: they remain in the separate Git content repository because that repository is the publication source of truth.

## Connection and migration model

`DATABASE_URL` is the server-side pooled runtime connection. `DATABASE_DIRECT_URL` is the direct/admin migration connection. `DATABASE_SCHEMA` defaults to `content_machine`; only this exact validated identifier is accepted. Runtime connections use a deliberately small pool and disable prepared statements for transaction-pooler compatibility. Migration commands use an advisory lock and record checksums in `content_machine.schema_migrations`.

Every SQL value is parameterized. Dynamic identifiers are limited to a hard validated schema name. Error reporting is normalized and redacts credentials/connection URLs. CLIs explicitly close their pools.

## Composition and readiness

The storage backend is explicit:

- Development and fixtures default to `file`.
- Production requires `STORAGE_BACKEND=postgres`, a valid server-only `DATABASE_URL`, the expected migration checksum/version, all critical tables/constraints, and a passing health check.
- Production with `file`, missing configuration, partial adapters, or a failed database check exits before handling workflow work.

Readiness progresses without skipping states: `LOCAL_READY`, `DATABASE_CODE_READY`, `DATABASE_CONNECTED`, `DATABASE_MIGRATED`, `DATABASE_PARITY_VERIFIED`, `STAGING_READY`, `PRODUCTION_READY`. Code presence alone is only `DATABASE_CODE_READY`.

## Security and operational decisions

- The database role receives only required access to `content_machine`; `public` and anonymous/browser roles receive none.
- `content_machine` is not an exposed Data API schema. RLS is not treated as a substitute for keeping the schema private.
- No visitor-level analytics or Telegram/GitHub/Vercel credentials are stored.
- Migrations are deterministic, ordered, checksum-verified, and guarded by an advisory lock.
- Foreign-key columns and actual lookup/lease/idempotency paths receive focused indexes.
- Local-file migration is dry-run-first, duplicate-safe, resumable, hash-verified, and never deletes its source.
- Supabase backup/PITR capabilities are plan-dependent and must be verified by the operator; documentation must not promise unavailable recovery features.

## Production dependency matrix policy

The final audit must map every row above to its file implementation, Postgres adapter or deliberate composed view, parity coverage, composition wiring, and live-verification state. Production cannot be enabled while any production-required row is missing or routes through local workflow state. Public Git content and explicitly ephemeral generated scratch files are not private workflow-state exceptions.
