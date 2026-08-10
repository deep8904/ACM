# Publication Pipeline

Milestone 7 converts one exact Telegram-final-approved draft into one public MDX commit and stops before social, image, newsletter, Medium, or analytics work.

## Safety and lifecycle

The `ArticleFinalApprovedEvent` stays immutable. The publisher loads its explicit draft, review, packet, final approval, and topic approval; recomputes the Milestone 6 snapshot hash before validation and immediately before commit; and rejects newer drafts, unresolved blocking or critical issues, unsafe MDX, unknown citations, inactive approvals, unready research, early or expired schedules, collisions, and private output.

Claims and consumption are private sidecars. Consumption occurs only after one confirmed article commit, a durable publication record, and the configured deployment policy. Required/manual verification failures leave the event unconsumed; best-effort consumption must be explicit. Retry reuses the event-keyed commit, and deployment failure cannot create a second article commit. Production remains fail-closed without explicitly configured private durable state and production confirmation.

## Transformation, paths, and sources

The pure transformer uses an injected UTC time, sets published metadata, creates `SITE_ORIGIN + BLOG_ROUTE_PREFIX + slug`, and defaults to `content/blog/YYYY/<slug>.mdx`. Paths are normalized and confined to the content root. Initial publication never overwrites different content.

Internal citation markers become stable, first-use numbered footnotes. Every ID must resolve. Tracking and credential query parameters are removed; credentialed, private-network, or non-HTTPS production URLs are rejected. Public snapshots contain concise references, never source extracts, claim/research/review IDs, approval notes, Telegram identifiers, private URLs, secrets, or storage paths. A final privacy and quotation-length check runs before commit.

## Repository and deployment

`ContentRepository` has local-fixture and GitHub Git Data adapters. One publication creates blobs/tree/one commit/ref update with an optimistic parent and verifies the written content. Direct-to-main must be explicit; `publication_branch` is safer for production. PR creation and rollback are intentionally not automatic.

An already-consumed successful fixture publication is never replayed through its final-approved event. The explicit `publish:republish` migration command creates a new immutable lineage record and a new publication branch. It verifies the source publication, consumed-event sidecar, approved snapshot, published snapshot expectation, and exact fixture file hash. The only permitted artifact change is replacing the fixture canonical URL with the configured real canonical URL; every other byte must remain identical. A deterministic target key makes the same source/repository/base-branch/path/content request idempotent. The original publication, consumption, event, draft, review, research packet, and approvals are read-only throughout this flow.

Vercel lookup matches the exact commit SHA and production target; it never selects a random latest deployment or treats preview as production. Policies are `required`, `best_effort`, and `manual`. Manual mode writes `data/tasks/publication/<publicationId>/` with instructions, a public-safe summary, and an import schema. Public-page checks require the expected 200 page, title, canonical URL, and fingerprint/title.

After a republish branch is merged, `publish:republish:verify` performs a separate read-only proof before it writes anything. It resolves production HEAD, proves the recorded republish commit is its ancestor, reads the exact article blob at production HEAD, checks the strict SHA-256 and canonical frontmatter, and requires a ready Vercel production deployment for that HEAD. Vercel deployment protection does not require anonymous page access; the operator must instead explicitly acknowledge the completed visual checks. A successful run writes one immutable `ProductionPublicationArtifact`. The artifact has a deterministic `publication_*` ID but lives separately from the original fixture publication, which remains unchanged. Social and analytics read only these verified production artifacts.

The default Vercel deployment lookup uses `VERCEL_TOKEN` and `VERCEL_PROJECT_ID`. When no Vercel REST token is available, set `VERCEL_DEPLOYMENT_METADATA_SOURCE=github`; this explicit adapter accepts only an exact-commit `Production` deployment created by the `vercel[bot]` GitHub identity, then reads its successful Vercel deployment status and `.vercel.app` URL. It does not accept generic commit checks or another deployer.

## Commands

```bash
npm run publish:next -- --fixtures /absolute/fixture-root
npm run publish:event -- --event-id <eventId> --fixtures /absolute/fixture-root
npm run publish:due -- --fixtures /absolute/fixture-root
npm run publish:status -- --event-id <eventId> --fixtures /absolute/fixture-root
npm run publish:verify -- --publication-id <publicationId> --file /absolute/verification.json --fixtures /absolute/fixture-root
npm run publish:republish -- \
  --source-publication-id <fixturePublicationId> \
  --expected-repository <owner/repo> \
  --expected-base-branch <branch> \
  --expected-source-content-hash <sha256> \
  --expected-approved-snapshot-hash <sha256> \
  --expected-published-snapshot-hash <sha256> \
  --dry-run

npm run publish:republish:verify -- \
  --republish-id <republishId> \
  --manual-verification-acknowledged \
  --dry-run

npm run publish:republish:status -- --republish-id <republishId>
```

`--dry-run` validates and returns a public-safe plan without repository mutation. Telegram commands are `/publications`, `/publication`, `/retry_deployment`, and `/verify_publication`; notifications never include article bodies.

`publish:republish` is GitHub-only and requires `publication_branch`. It does not merge the branch, create a pull request, consume another event, or claim a Vercel production deployment. After merge and visual review, rerun `publish:republish:verify` without `--dry-run`; retry reuses the same production artifact. Never pass a republish ID to `publish:verify`, and never verify the source fixture as production.

## Production setup

Copy `automation/config/publication.example.yaml`. Configure an HTTPS origin, repository, branch, content root, and a narrow `BLOG_GITHUB_TOKEN` or GitHub App with Contents read/write and Metadata read. Automated Vercel checks additionally need `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, and optional `VERCEL_TEAM_ID`.

Before every standalone production CLI, source `.env.local`. Configure `STORAGE_BACKEND=postgres`, supply the server-side database connection, apply and verify all checksummed migrations, choose GitHub mode and preferably publication branches, store secrets server-side, verify staging commit/deployment matching, and deliberately enable the guarded workflow. The disabled example workflow does not provision or migrate durable storage.

Pre-commit failures make no public mutation. Commit/persistence recovery searches by event idempotency key and verifies exact file content. Deployment polling resumes without redeploying or recommitting. Conflicting state fails for operator inspection. Known limits are local file sidecars, blog-specific MDX rendering, no PR creation, no automated rollback, and public fingerprint support that depends on the target blog output.
