# V1 One-Time Production Setup

Daily operation is Telegram-only after this checklist passes.

## 1. Google AI provider

- Create one official Gemini API key in Google AI Studio for the automation project.
- Add it as the protected `GOOGLE_AI_API_KEY` secret in the ACM GitHub production environment and Vercel project.
- Set `GOOGLE_AI_MODEL` as a repository/environment variable when overriding the checked default.
- Never use browser automation against the Gemini consumer website.

## 2. GitHub Actions

Configure the ACM repository's protected `production` environment with:

- `DATABASE_URL`, `DATABASE_DIRECT_URL`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CALLBACK_SECRET`
- `BLOG_GITHUB_TOKEN` scoped to `deep8904/Deep-Blog` Contents read/write, Metadata read, and Deployments read
- `GOOGLE_AI_API_KEY`, `PREVIEW_SIGNING_SECRET`, `CRON_SECRET`

Set `CONTROL_PLANE_ORIGIN` as a GitHub environment variable. The checked-in `automation-worker.yml` handles migration checks, reconciliation, leases, retries, and long-running stages.

## 3. Vercel control plane

Connect `deep8904/ACM` to a Vercel project and set the project root to this repository root. Configure:

- `NODE_ENV=production`, `STORAGE_BACKEND=postgres`
- pooled `DATABASE_URL`
- Telegram token, allowlists, webhook secret, and callback secret
- `CONTROL_PLANE_ORIGIN` equal to the permanent Vercel origin
- `PREVIEW_SIGNING_SECRET`, `CRON_SECRET`
- `BLOG_GITHUB_TOKEN`, `BLOG_REPOSITORY=deep8904/Deep-Blog`, `BLOG_DEFAULT_BRANCH=main`
- `PUBLICATION_CONFIG=automation/config/publication.production.yaml`
- `VERCEL_DEPLOYMENT_METADATA_SOURCE=github`

The stable endpoints are:

- `POST /api/telegram/webhook`
- `GET /api/health`
- `GET /api/cron/reconcile` with Vercel's cron authorization
- `GET /api/preview/<signed-id>` for expiring private article previews

## 4. Permanent Telegram webhook

Register exactly once:

```text
https://<permanent-control-origin>/api/telegram/webhook
```

Use the configured webhook secret token. Remove the old `trycloudflare.com` webhook. Confirm `/system_status` shows the webhook, database, scheduler, and worker healthy.

## 5. Go/no-go

- Database migration is `018/018` and valid.
- The GitHub worker workflow completes from `workflow_dispatch` without a laptop.
- `/api/health` returns ready.
- Telegram `/system_status` returns ready.
- Read-only GitHub checks can resolve Deep-Blog main, the existing production article bytes, and a `vercel[bot]` Production deployment.
- A non-publishing simulation reaches final-review state and a publication dry-run rejects unexpected diffs/hash mismatches.

Do not enable routine publishing until every item above passes. Missing readiness always fails closed.
