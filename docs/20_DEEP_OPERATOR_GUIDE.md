# Deep's V1 Operator Guide

> Daily operation: use Telegram. You do not need VS Code, npm commands, Cloudflare, a local tunnel, or manual GitHub publication steps.

## Normal article flow

1. The hosted worker runs discovery and ranking exactly twice per week, Monday and Thursday at 16:00 UTC. Each run covers the durable previous-successful-window boundary through the current slot.
2. Telegram sends one compact batch of about three to four deduplicated, highest-ranked topics.
3. Tap **Approve** or **Skip**. Use `/refresh`, `/skip_cycle`, `/add <topic>`, or `/link <https://…>` when needed.
4. After approval, research, evidence validation, writing, deterministic checks, editorial review, and bounded revisions run automatically.
5. Telegram sends one final article card with a signed remote preview.
6. Tap **Approve**, **Request changes**, **Hold**, or **Reject**. A change note automatically creates a new immutable draft and review.
7. Final approval creates the exact approved publication artifact, commits only that MDX file to `deep8904/Deep-Blog`, waits for the Vercel production deployment, verifies production-main ancestry, canonical URL, and SHA-256 content, and records an immutable production artifact.
8. Telegram sends **Published ✓** with the live canonical URL.

Topic approval and exact final-article approval are mandatory and cannot be bypassed. Social distribution remains a separate, non-blocking later workflow.

## Telegram commands

- `/topics` — current ranked recommendations.
- `/refresh` — show unused candidates from the current ranking run.
- `/skip_cycle` — skip all currently pending recommendations.
- `/add <topic>` — submit a custom topic.
- `/link <url>` — submit an authoritative starting URL.
- `/queue` — topic approval queue.
- `/status <topic_id>` — one topic's state.
- `/drafts` — current final-review states.
- `/review <topic_id>` — reopen the final article card.
- `/publications` — recent publication states.
- `/jobs` — actionable automation cards; blocked research includes `Resume research`.
- `/jobs all` — recent automation history, job IDs, and diagnostics.
- `/retry <automationjob_id>` — retry a failed or blocked job from a clean attempt budget.
- `/cancel_job <automationjob_id>` — cancel work that has not started running.
- `/system_status` — database, webhook, scheduler, worker, GitHub, Vercel, and AI-provider readiness.
- `/interests` — view configurable editorial interests and use Enable, Disable, or Remove buttons.
- `/interest_add Name | keyword one, keyword two` — add or re-enable an interest.
- `/interest_enable <interest_id>`, `/interest_disable <interest_id>`, `/interest_remove <interest_id>` — command alternatives to the buttons.
- `/help` — compact command reference.

## Recovery

Failures stop safely. Telegram shows a short reason and diagnostic reference, never a secret or internal stack trace.

- Transient provider, network, Telegram, GitHub, and Vercel failures use bounded exponential retries.
- A crashed worker's lease expires and another worker reclaims the same deterministic job.
- Schema-invalid AI output is rejected and retried; it is never silently accepted.
- Evidence, quality, snapshot, unexpected-content, canonical, ancestry, content-hash, and deployment mismatches fail closed.
- After the retry budget, a job becomes `failed` or `blocked`. Use `/jobs`; recoverable research resumes from its button without a job ID. Use `/jobs all` and `/retry <job_id>` only for explicit diagnostics and non-research operations.
- Use `/cancel_job` only for queued/blocked work. A running publication cannot be cancelled midway because that could misrepresent repository state.

## Hosted architecture

- Vercel Hobby: stable HTTPS Telegram webhook, health endpoint, signed private previews, and authenticated control routes. No Vercel-native cron is required and no Pro upgrade is needed.
- GitHub Actions: primary scheduler, reconciler, and lease-based worker every fifteen minutes; no laptop process is involved. Each run writes the scheduler and worker heartbeats used by `/system_status`.
- Supabase/Postgres: sole durable workflow, artifact, approval, queue, lease, provenance, and audit source of truth.
- Google Gemini API: structured research synthesis, writing, editorial review, and revision through a provider abstraction. Deterministic evidence and quality gates remain authoritative.
- GitHub `deep8904/Deep-Blog`: exact compare-and-swap commit of one approved MDX artifact to `main`.
- Vercel Git integration: production deployment verified from exact `vercel[bot]` GitHub deployment metadata plus public page checks.

## One-time setup

Complete `docs/21_PRODUCTION_SETUP_CHECKLIST.md` once. `/system_status` reports any category still missing. The only new external account item is an official Gemini API key; a consumer Gemini subscription does not imply API access.

## Audit history

Private audit data is in the non-exposed Postgres `content_machine` schema:

- `automation_jobs` and `automation_heartbeats`
- `llm_invocations`
- immutable research packets, article drafts, editorial reviews, approvals, events, publications, and production publication artifacts
- Telegram update and callback replay records
- editorial interests and their append-only change history

`/system_status` also shows the last successful discovery, current discovery window, and next discovery slot. The 15-minute worker cadence is for continuing research, writing, review, and publication work; it does not increase the twice-weekly discovery cadence.

## Advanced recovery only

The `npm` commands remain available for developers and disaster recovery. They are not part of daily operation. Never use manual imports or publication commands to bypass Telegram approval, immutable version lineage, or production verification.
