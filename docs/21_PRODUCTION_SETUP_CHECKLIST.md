# V1 One-Time Production Setup

Daily operation is Telegram-only after this checklist passes.

## 1. Google AI provider

- Create dedicated API keys for Groq, OpenRouter, and Gemini for the automation project.
- Add protected `GROQ_API_KEY`, `OPENROUTER_API_KEY`, and `GEMINI_API_KEY` secrets in the ACM GitHub production environment and Vercel project. Runtime order is Groq, then OpenRouter, then Gemini; every fallback is recorded in `llm_invocations`.
- The worker temporarily accepts the legacy `GOOGLE_AI_API_KEY` secret as the Gemini value so rollout does not interrupt existing jobs. Remove the legacy secret after `GEMINI_API_KEY` is configured and `/system_status` reports the full provider chain ready.
- Set `GOOGLE_AI_MODEL` as a repository/environment variable when overriding the checked default.
- Never use browser automation against the Gemini consumer website.

## 2. GitHub Actions

Configure the ACM repository's protected `production` environment with:

- `DATABASE_URL`, `DATABASE_DIRECT_URL`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CALLBACK_SECRET`
- `BLOG_GITHUB_TOKEN` scoped to `deep8904/Deep-Blog` Contents read/write, Metadata read, and Deployments read
- `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `PREVIEW_SIGNING_SECRET`, `CRON_SECRET`

Set `CONTROL_PLANE_ORIGIN` and `SITE_ORIGIN` as GitHub environment variables. `SITE_ORIGIN` must be the permanent public blog origin. The checked-in `automation-worker.yml` is the primary scheduler and uses two off-peak, offset hourly schedules for nominal twice-hourly wakeups. It handles migration checks, twice-weekly discovery slot reconciliation, leases, retries, and long-running stages. Its concurrency guard prevents overlapping workers, `workflow_dispatch` provides a safe manual trigger, and delayed wakeups reconcile missed durable work. Durable slot idempotency ensures that worker frequency cannot increase discovery beyond Monday and Thursday at 16:00 UTC.

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
- `GET /api/cron/reconcile` with bearer `CRON_SECRET` authorization (optional control endpoint; not called by a Vercel-native cron)
- `GET /api/preview/<signed-id>` for expiring private article previews

The project has no Vercel Cron Jobs configuration. Vercel Hobby therefore deploys without a paid plan; normal scheduling and worker execution happen in GitHub Actions.

## 4. Permanent Telegram webhook

Register exactly once:

```text
https://<permanent-control-origin>/api/telegram/webhook
```

Use the configured webhook secret token. Remove the old `trycloudflare.com` webhook. Confirm `/system_status` shows the webhook, database, scheduler, and worker healthy.

## 5. Go/no-go

- Database migration is `025/025` and valid.
- The GitHub worker workflow completes from `workflow_dispatch` without a laptop.
- A scheduled or manually dispatched worker run writes a fresh `github_actions` scheduler heartbeat and a fresh worker heartbeat.
- `/api/health` returns ready.
- Telegram `/system_status` returns ready.
- `/system_status` reports the last discovery, current window, and next discovery; `/interests` lists the four seeded categories.
- Read-only GitHub checks can resolve Deep-Blog main, the existing production article bytes, and a `vercel[bot]` Production deployment.
- A non-publishing simulation reaches final-review state and a publication dry-run rejects unexpected diffs/hash mismatches.

Do not enable routine publishing until every item above passes. Missing readiness always fails closed.
