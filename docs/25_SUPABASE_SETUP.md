# Supabase Setup for Deep

This guide creates the database from checked-in migrations. Do not create tables manually. The code is implemented, but the real project is not considered connected or production-ready until every verification below passes.

## 1. Create the project

Open the Supabase Dashboard, create a private project, choose the organization, and use the intended project reference. Choose the closest region to the application runtime. Changing region later generally means migrating data, so choose deliberately.

Generate a strong unique database password and save it in a password manager. Do not send it in Telegram, email, GitHub issues, or this Codex task.

## 2. Copy the two connection strings

In the project, click **Connect**.

- Copy the **Transaction pooler** connection string (normally port `6543`) for `DATABASE_URL`. It is appropriate for temporary/serverless runtime connections. This project disables prepared statements for transaction-pooler compatibility.
- Copy the **Direct connection** string (normally port `5432`) for `DATABASE_DIRECT_URL`. Use it for migrations, `pg_dump`, and administrative checks. Direct connections can require IPv6; if the local network cannot reach it, use the documented Supabase session-pooler alternative for migration access.

Both values are server secrets. Do not use `NEXT_PUBLIC_*`.

## 3. Configure the local server

Create or edit `.env.local` (already ignored by Git):

```env
STORAGE_BACKEND=postgres
DATABASE_URL=postgresql://<runtime-pooler-user>:<password>@<pooler-host>:6543/postgres
DATABASE_DIRECT_URL=postgresql://<direct-user>:<password>@<direct-host>:5432/postgres
DATABASE_SCHEMA=content_machine
DATABASE_MAX_CONNECTIONS=5
```

Do not quote or commit real values. Do not add the private schema to client code.

## 4. Check, migrate, and verify

From the project root:

```bash
npm run db:status
npm run db:migrate
npm run db:verify
npm run db:health
npm run production:readiness
```

Expected: migration `011`, no pending migrations, no missing critical tables, and readiness `DATABASE_MIGRATED` (not `PRODUCTION_READY`).

## 5. Confirm schema privacy

In Supabase **Project Settings → API**, inspect exposed schemas. `content_machine` must **not** be listed. The application uses trusted server-side Postgres connections, not browser Data API access. Do not grant `anon` or `authenticated` access to `content_machine`.

In the SQL/Table views, confirm the `content_machine` schema and approximately 60 tables, including `schema_migrations`, `telegram_updates`, `research_packets`, `article_drafts`, `final_approved_events`, `publications`, `social_packages`, and `performance_snapshots`.

## 6. Test against a non-production database

Set `TEST_DATABASE_URL` and, when necessary, `TEST_DATABASE_DIRECT_URL` to a disposable/local/test Postgres database—not the production database—then run:

```bash
npm run test:postgres
npm run test:parity
npm run test:concurrency
npm run test:recovery
npm run test:simulation:postgres
```

The normal `npm test` remains offline and does not need Supabase.

## 7. Migrate private file state

Always inspect first:

```bash
npm run storage:migrate -- --from file --to postgres --dry-run
```

Read the generated manifest in `data/migration-manifests/`. Resolve every `error`; review `preserved_artifact` entries. Then:

```bash
npm run storage:migrate -- --from file --to postgres --confirm
```

The tool uses Telegram → research → writing → review → publication → social → analytics order, hashes each file, is duplicate-safe for immutable aggregates, keeps a resumable manifest, and never deletes source files.

## 8. Validate and stage

Run the legacy simulation and complete validation suite. Compare file/Postgres counts and hashes. Keep `DATABASE_PARITY_VERIFIED`, `STAGING_VERIFIED`, and `PRODUCTION_DURABLE_STORAGE_VERIFIED` unset until their corresponding work has actually happened. Production fails closed with file storage, missing URLs, bad migrations, missing tables, or failed health.

## 9. Protected deployment secrets

Later add `STORAGE_BACKEND`, `DATABASE_URL`, `DATABASE_SCHEMA`, and provider secrets to protected Vercel/GitHub environment settings. Use the pooled runtime URL in Vercel. Keep the direct URL limited to controlled migration/backup environments. Never expose either connection string to a browser bundle.
