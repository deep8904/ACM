# Telegram Topic Approval

Milestone 3 implements topic approval only. It does not research sources, write articles, review drafts, publish, create social content, invoke an AI model, or implement final article approval. Every approved topic still requires research in Milestone 4 and a separate mandatory final article approval gate before any future publication.

## Architecture

`TopicApprovalService` contains provider-neutral command and state-transition logic. `EditorialNotificationAdapter`, `TopicApprovalRepository`, and `TopicCatalog` isolate Telegram delivery, state, and immutable ranking artifacts. `TelegramBotApiClient` is the provider adapter. The Next.js route at `POST /api/telegram/webhook` validates requests before calling the service.

Local and test state uses `FileTelegramRepository`, with one JSON record per entity and atomic rename-based writes. Updates and callback IDs are claimed with exclusive file creation. Approval events are persisted but never consumed in this milestone.

The Chat SDK architecture guidance informed the adapter/event boundary, but no Chat SDK or AI SDK dependency was installed. The narrow Telegram Bot API client keeps Milestone 3 deterministic and avoids unrelated multi-platform or AI functionality.

## Security model

- The webhook requires `X-Telegram-Bot-Api-Secret-Token`; the current and previous secrets support rotation.
- JSON content type and a 64 KiB body limit are enforced.
- Both the numeric chat ID and numeric user ID must be configured. Display names and usernames are never trusted.
- Group or supergroup use requires the group chat ID and the acting member's user ID. Channel updates are rejected.
- Development authorization override is ignored in production.
- Callback payloads contain only action, 12-character server-side topic reference, version, and truncated HMAC signature. They remain below 64 bytes.
- Bot tokens and webhook secrets are never written to state or logs.
- Operational errors are concise; webhook responses never contain internal stack traces.

## Environment variables

Telegram variables are optional for discovery, ranking, tests, and builds. They are validated when Telegram functionality is invoked.

- `TELEGRAM_BOT_TOKEN`: BotFather token.
- `TELEGRAM_ALLOWED_CHAT_IDS`: comma-separated numeric IDs.
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric IDs.
- `TELEGRAM_WEBHOOK_SECRET`: current secret token, minimum 16 characters.
- `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`: optional rotation overlap.
- `TELEGRAM_CALLBACK_SECRET`: callback HMAC key; defaults to webhook secret.
- `TELEGRAM_WEBHOOK_URL`: public HTTPS route.
- `TELEGRAM_PARSE_MODE`: `HTML` only.
- `TELEGRAM_STATE_DIRECTORY`: local/test state root.
- `TELEGRAM_RUNS_DIRECTORY`: immutable ranked-run root.
- `TELEGRAM_CONVERSATION_TTL_MINUTES`: pending-input lifetime.
- `TELEGRAM_TOPIC_EXPIRY_HOURS`: ranked recommendation lifetime.
- `TELEGRAM_RECOMMENDATION_BATCH_SIZE`: cards per request.
- `TELEGRAM_MAX_SOURCE_PREVIEW`: source rows per preview.
- `TELEGRAM_DEV_ALLOW_UNAUTHORIZED`: development-only override; keep `false` normally.

## Commands

- `/start`: product summary, state, commands, and pending count.
- `/topics [runId]`: latest or selected valid ranked run.
- `/approve 1,3` or `/approve topic_id`: approve one or more topics.
- `/reject 1,3` or `/reject topic_id`: reject one or more topics.
- `/replace`: next unused eligible candidates; never starts discovery.
- `/add <topic>`: create an unresearched manual topic.
- `/link <url>`: validate and record a manual URL without fetching it.
- `/queue [all]`: active queue or all statuses.
- `/status <topic_id>`: approval, readiness, and handoff state.
- `/cancel [topic_id]`: clear pending input, or cancel an approved unconsumed topic.
- `/help`: commands and gate warning.

No final-article commands exist yet.

## Callbacks and cards

Signed callback forms are `t:a:<short-id>:<version>:<signature>`, with `a`, `r`, `s`, `g`, and `n` representing approve, reject, sources, change angle, and add note. Every callback resolves server-side state and rejects a bad signature, unknown record, expired topic, superseded run, or stale version.

Ranked cards include deterministic score, title, summary, trend reasons, angle, evidence label, primary and independent source counts, shelf life, risks, and selection reasons. HTML is escaped and messages are capped at Telegram's limit. Source previews show only normalized metadata and at most the configured count; no article page is fetched.

## Manual topic and URL behavior

Manual topics have `score: null`, `evidenceStrength: unresearched`, and `selectionReasons: ["manually submitted"]`. They never pretend to be trending.

Manual URLs allow HTTP or HTTPS, remove tracking parameters, normalize hosts and query order, reject credentials and unsafe ports, and resolve DNS before acceptance. Localhost, loopback, RFC1918, carrier-grade NAT, link-local, documentation/reserved ranges, multicast, IPv6 ULA/link-local, and cloud metadata targets are rejected. Milestone 3 performs no fetch and therefore no redirect handling; future fetchers must revalidate every redirect target.

## Conversation states

Follow-up input is scoped by chat and user. Supported states are custom topic, URL, angle, note, and optional rejection reason. State expires after the configured TTL. `/cancel` clears it. Unexpected text gets a bounded help response; this is not a conversational AI system.

## Persistence and idempotency

Local layout:

```text
data/telegram/
  processed-updates/
  processed-callbacks/
  approvals/
  queue/
  conversations/
  message-index/
data/events/topic-approved/
```

Reads validate Zod schemas. Corrupt files fail visibly. Writes use mode `0600`, stable JSON, and atomic rename. Optimistic versions reject stale queue and event writes. The implementation assumes one local writer; it is not a distributed transaction store.

Duplicate `update_id` and callback query IDs are acknowledged without repeating state transitions. Approval IDs and event IDs are deterministic, and exclusive event creation prevents duplicate handoffs. Immutable `ranked-topics.json` and related Milestone 2 artifacts are never rewritten.

## Topic-approved event

Approval creates exactly one provider-neutral event in `data/events/topic-approved/`. It includes topic/candidate/run IDs, approving numeric IDs, angle, notes, source item IDs, origin, version, and `consumed: false`. It is a Milestone 4 placeholder only. Editing an approved topic updates the unconsumed event; cancelling marks it cancelled. No consumer exists yet.

## Webhook setup

After setting environment variables:

```bash
npm run telegram:webhook:set
npm run telegram:webhook:info
npm run telegram:webhook:delete -- --confirm-delete
```

The setup command requires HTTPS and prints only the webhook host/status. The destructive delete requires the explicit flag.

## Local replay

Replay calls the service with an offline recording adapter and never contacts Telegram:

```bash
npm run telegram:replay -- \
  --fixture tests/fixtures/telegram/start.json \
  --state /tmp/ai-content-telegram-replay \
  --runs data/runs
```

Mock calls are written to `replay-calls.json`. Automated integration tests build a ranked fixture run, send `/topics`, callbacks, manual inputs, and a duplicate update entirely offline.

## Bot creation and authorized IDs

Deep must complete these steps later:

1. Open Telegram and message `@BotFather`.
2. Run `/newbot`.
3. Choose a display name.
4. Choose a unique username ending in `bot`.
5. Copy the token once into `TELEGRAM_BOT_TOKEN`; never commit or paste it into logs.
6. Send a private message to the new bot.
7. Obtain the numeric user and chat IDs from a temporary authenticated `getUpdates` response or a locally logged metadata-only fixture, then disable polling. Do not use a third-party ID bot for private data.
8. Add the IDs to both allowlists and create strong independent webhook/callback secrets.
9. Set `TELEGRAM_WEBHOOK_URL` to the HTTPS `/api/telegram/webhook` route and run the set/info commands.
10. Send `/start` and confirm authorization and status.

## Vercel and production durability decision

Vercel serverless local disk is not durable. The source repository is public, so GitHub Contents API storage would expose user/chat IDs, custom topics, notes, approvals, and behavioral metadata. Milestone 3 therefore does not write private state to the public repository and does not claim production readiness.

Production webhook construction fails closed with `production_durability_unavailable`. Before production, Deep must select a private zero-cost durable backend, such as a separate private state repository with a narrowly scoped token, and implement it behind `TopicApprovalRepository` with conflict retries. GitHub Actions can later consume topic-approved events from that private backend or receive an authenticated repository dispatch. This is a documented production blocker, not a reason to weaken privacy.

## Privacy review

- Source-controlled fixtures use fake IDs only.
- `data/telegram/`, `data/events/`, and replay output are ignored by Git.
- No real IDs, notes, URLs, approval state, or message history enter tracked files.
- Logs contain masked chat IDs and command/action types, not private message text or URL query parameters.
- Callback data contains no title, note, URL, token, or raw state.
- Generated local artifacts can contain personal/editorial data and must be treated as private.

## Known limitations and deferred work

- File state is single-writer and local/test only.
- DNS validation protects intake, but future fetch and redirect validation belongs to Milestone 4.
- Telegram rate limiting beyond Bot API retry behavior is deferred until a durable distributed state backend exists.
- `/replace --new-run` is intentionally unsupported; replacement never starts discovery.
- Research packets, drafting, final review, final article approval, publishing, social generation, analytics, and AI execution remain unimplemented.
- Final article approval remains a separate mandatory future gate and cannot be inferred from topic approval.
