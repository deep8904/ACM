# Database Backup and Recovery

The durable system of record includes the entire private `content_machine` schema: approvals, outboxes, jobs and leases, immutable content versions, publication lineage, social state, aggregate analytics, private task/artifact contents, and `schema_migrations`. The separate public blog Git repository must also be backed up. This release stores bounded private artifacts in Postgres, so there is no Supabase Storage bucket to back up.

## Backup policy

Keep an encrypted logical dump outside the Supabase project. For a free project, do this before every migration and at least weekly while active. Supabase currently recommends regular `supabase db dump` exports and off-site retention for free projects; automatic daily backups and PITR depend on plan/features and must be checked in the Dashboard rather than assumed.

Example with standard Postgres tools (run locally; do not paste the URL into chat or shell history):

```bash
mkdir -p private-backups
pg_dump --format=custom --no-owner --no-acl \
  --schema=content_machine \
  --file="private-backups/content-machine-$(date +%Y%m%d-%H%M%S).dump" \
  "$DATABASE_DIRECT_URL"
```

Encrypt the dump with an operator-controlled tool/key and copy it to at least one separate private location. `private-backups/` is ignored by Git. Never put a dump in the public blog repository. Database dumps contain unpublished text, Telegram identifiers, and operational history.

## Restore procedure

1. Stop Telegram webhooks and all stage workers. Record the last known publication/social external effects.
2. Create or select the recovery Postgres project. Do not restore over the only copy until the dump has been tested.
3. Configure `DATABASE_DIRECT_URL` for the recovery target and run `npm run db:status`.
4. Restore with `pg_restore --no-owner --no-acl --clean --if-exists --dbname="$DATABASE_DIRECT_URL" <dump-file>`.
5. Run `npm run db:verify`, then `npm run production:readiness`.
6. Run `npm run test:parity`, `npm run test:concurrency`, `npm run test:recovery`, and `npm run test:simulation:postgres` with `TEST_DATABASE_URL` pointed at a non-production restored copy.
7. Compare event/outbox rows with Git commits and deployed canonical URLs. Reconcile external effects before re-enabling workers.
8. Rotate custom-role passwords if the backup mechanism did not retain them. Re-enter provider secrets from the secret manager; secrets are not workflow rows.
9. Re-enable one worker family at a time, ending with Telegram webhook traffic.

## Restore validation

The restore is acceptable only when migration checksums match, no critical table is missing, both approval gates retain their exact-version records, immutable version counts match the source, every consumed event resolves to its output, every publication resolves to its commit SHA, and the secret scan remains clean.

## Recovery limits

- Free-plan automatic backups and PITR must not be assumed. Take independent logical dumps.
- A daily backup can lose changes since the backup. PITR is a paid/add-on capability whose current availability and retention must be verified before relying on it.
- Supabase database backups do not restore deleted Storage objects. This project currently keeps private artifacts in Postgres, but this warning becomes material if a future `PrivateArtifactStore` uses Supabase Storage.
- Restoring Postgres cannot undo an already-pushed Git commit, deployed page, Telegram message, or manually posted social URL. Use idempotency keys and reconciliation records.

## Disaster checklist

- Keep workers stopped.
- Preserve logs and the damaged database read-only if possible.
- Identify the last trustworthy event/version/commit.
- Restore to a separate target.
- Verify migrations, constraints, counts, hashes, lineage, and external effects.
- Rotate credentials if compromise is suspected.
- Document the recovery point and unavoidable data gap.
- Resume in dependency order: Telegram, research, writing, review, publication, social, analytics.
