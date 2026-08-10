# Deep's Supabase Handoff

Only remaining personal account and secret-bearing actions are listed here. Codex applied and verified migrations 001–011, 60 private tables, checksums, privileges, and advisors through the authenticated Supabase connector.

## Copy server-side connection strings

Where: The selected Supabase project → **Connect**.

What to click: Transaction pooler and Direct connection string options.

What to enter: Substitute the database password locally when Supabase shows a placeholder.

What NOT to share: Either completed URL. Do not paste them into chat and do not name them `NEXT_PUBLIC_*`.

What command to run: None.

Expected result: One pooled runtime URL and one direct migration URL for the already-migrated project.

What to do next: Put them in local `.env.local`.

## Configure local secrets

Where: `.env.local` in the AI Content Machine project root.

What to click: Open the file in a local editor.

What to enter: `STORAGE_BACKEND=postgres`, `DATABASE_URL=<pooled URL>`, `DATABASE_DIRECT_URL=<direct URL>`, and `DATABASE_SCHEMA=content_machine`.

What NOT to share: The file contents. Do not commit `.env.local`.

What command to run:

```bash
npm run db:status
npm run db:migrate
npm run db:verify
npm run production:readiness
```

Expected result: Migration `011`, no pending checksum changes, healthy database, and readiness no higher than `DATABASE_MIGRATED` until parity is run. `db:migrate` is safe and should report nothing new to apply.

What to do next: Configure a disposable test database and run Postgres tests.

## Verify schema privacy

Where: Supabase Dashboard → Project Settings → API.

What to click: Exposed schema settings.

What to enter: Nothing. Confirm `content_machine` is absent.

What NOT to share: API keys displayed on this page.

What command to run: `npm run db:verify`.

Expected result: Private tables exist but are not offered through the browser Data API.

What to do next: Review the two outstanding advisor decisions below, then run the file-state dry run.

## Review outstanding security advisors

Where: Supabase Dashboard → Database advisors and SQL editor.

What to click: Security advisor details for RLS-disabled private tables and `public.rls_auto_enable()`.

What to enter: Nothing until you identify who created `public.rls_auto_enable()` and whether it is still needed. If it is not intentionally public, revoke its execution from `anon` and `authenticated` using a reviewed migration. Decide separately whether to enable RLS-with-no-browser-policies as defense in depth for `content_machine`; direct trusted-server database access does not need browser policies.

What NOT to share: Dashboard keys, connection strings, function contents containing secrets, or database dumps.

What command to run: `npm run db:verify` after any reviewed security migration.

Expected result: `content_machine` stays absent from exposed Data API schemas; `anon` and `authenticated` retain no schema/table privileges. The unrelated public security-definer warnings are resolved only after their ownership and purpose are confirmed.

What to do next: Configure a disposable test database, not the production project, for parity and destructive recovery tests.

## Migrate and test state

Where: Terminal in the project root.

What to click: Nothing.

What to enter: No secrets beyond the local environment file.

What NOT to share: Migration manifests; they contain private paths and workflow metadata.

What command to run against the configured production database for state migration, then against a separate disposable test database for the test commands:

```bash
npm run storage:migrate -- --from file --to postgres --dry-run
npm run storage:migrate -- --from file --to postgres --confirm
npm run test:postgres
npm run test:parity
npm run test:concurrency
npm run test:recovery
npm run test:simulation:postgres
```

Expected result: The dry run reports exact source counts before confirmation; no source files are deleted. Postgres-specific suites pass against a non-production test database.

What to do next: Perform staging verification before setting any readiness attestation variables.

## Add deployment secrets later

Where: Protected Vercel/GitHub environment settings.

What to click: Project/repository environment or secret settings.

What to enter: Pooled `DATABASE_URL`, `STORAGE_BACKEND=postgres`, `DATABASE_SCHEMA=content_machine`, and the existing Telegram/GitHub/Vercel secrets required by that runtime. Keep `DATABASE_DIRECT_URL` only where migration/backup commands run.

What NOT to share: Every secret value. Never expose them to preview logs, client variables, or the public blog repository.

What command to run: `npm run production:readiness` in staging.

Expected result: `DATABASE_PARITY_VERIFIED` only after real parity evidence; later `STAGING_READY` after a staged end-to-end run. `PRODUCTION_READY` requires the explicit final verification and must not be set just because code deployed.

What to do next: Preserve the Telegram topic approval and final article approval gates during the staged run, then follow the production checklist.
