# Telegram Approval System

Milestone 6 adds a separate signed `a:` callback namespace and separate bounded conversation state for final article approval. Topic `t:` callbacks cannot approve articles. Final cards contain summary metadata only and create an unconsumed event instead of publishing. See [Editorial Review and Final Approval](15_EDITORIAL_REVIEW_AND_FINAL_APPROVAL.md).

## 1. Purpose

Telegram is the control plane for the content machine. It replaces email notifications and avoids requiring the user to open a dashboard for routine editorial decisions.

## 2. Bot commands

- `/start`: onboarding and current system status.
- `/topics`: current topic recommendations.
- `/approve <ids>`: approve one or more topic IDs.
- `/reject <ids>`: reject recommendations.
- `/replace`: request replacement topics.
- `/add <topic>`: submit a custom topic.
- `/link <url>`: submit a source URL.
- `/queue`: show approved and active work.
- `/drafts`: show drafts awaiting review.
- `/status <id>`: show pipeline state.
- `/cancel <id>`: cancel an unpublished item.
- `/help`: explain commands.

Inline keyboards should cover the most common actions so typing is optional.

## 3. Topic card

Example:

```text
Topic 03 · Score 88
Figma changes its developer handoff workflow

Why now:
Official release plus strong designer discussion in the last 18 hours.

Recommended angle:
What changed, which teams benefit, and where the workflow still falls short.

Evidence:
1 primary source · 4 independent sources

Shelf life:
Medium, likely 2-6 weeks

[Approve] [Reject] [Sources] [Change angle]
```

## 4. Custom topic flow

When the user enters a topic:

1. Create a manual topic record.
2. Ask for optional angle or notes.
3. Run discovery around the topic.
4. Return a brief evidence and risk summary.
5. Ask for approval.
6. Continue to full research.

When the user submits a URL:

1. Validate scheme and host.
2. Reject private or unsafe targets.
3. Canonicalize the URL.
4. Extract title and basic metadata.
5. Search for primary and confirming sources.
6. Present a topic card.

## 5. Final review card

The final review should include:

- Title.
- Article type.
- Word count.
- Source count.
- Research confidence.
- Quality flags.
- Preview link.
- Planned social outputs.

Buttons:

- Publish now.
- Schedule.
- Request changes.
- Regenerate title.
- Regenerate introduction.
- Hold.
- Reject.

## 6. Revision requests

The user should be able to write a natural request such as:

- "Make the introduction shorter."
- "Add more detail about pricing."
- "Do not make it sound too positive."
- "Use the second headline."
- "Remove the Instagram package."

Store each request as an editorial instruction tied to the article version.

## 7. Security

- Use Telegram webhook secret token validation.
- Allow commands only from configured chat IDs.
- Never expose source extracts or credentials in callback data.
- Callback data should contain short opaque identifiers.
- Log unauthorized attempts without sensitive payloads.
- Rate-limit webhook processing.

## 8. Idempotency

Telegram may retry updates. Store `update_id` and callback IDs so repeated deliveries do not trigger duplicate research, publication, or commits.

## 9. Blocked research recovery

Remediable evidence failures use a signed `q:` callback namespace and migration-019 durable conversation state. The state is scoped to the authorized chat/user plus the exact topic, approved event, automation job, and latest packet version. Callback signatures, global Telegram update/callback claims, state versions, and expiry jointly prevent tampering and replay.

The primary flow is:

```text
Research blocked
→ Add primary source
→ paste a public URL
→ review publisher / ownership / proposed authority
→ Confirm primary or Treat as independent
→ immutable packet extension
→ Gemini synthesis
→ unchanged evidence gates
```

HTTP 429, HTTP 403, robots exclusion, unsafe/private URLs, and duplicates produce concise operator messages with server-side diagnostic references. `/add_source <topicId>` and `/research_source <topicId>` reopen an eligible blocked flow; buttons remain the normal interface. `/queue` and `/status` display `awaiting_source` while the topic is blocked for operator evidence.

`/jobs` is the normal recovery entry point. It derives actionable research from the current approved event, consumed event state, latest insufficient packet, active queue readiness, and a canonical blocked research handoff. Malformed, orphaned, superseded, cancelled, and terminal records are omitted. Each actionable lineage appears once as a compact card with `Resume research`; tapping it immediately acknowledges the callback and atomically rotates the actor-scoped remediation version and expiry before sending a fresh recovery card. Older cards become stale. `/jobs all` is the explicit read-only diagnostic view for recent historical records and job IDs.

## 10. Milestone 3 implementation boundary

The implemented topic control layer is documented in `docs/12_TELEGRAM_TOPIC_APPROVAL.md`. Topic approval persists an unconsumed handoff event only. Research, draft controls, final review cards, final article approval, publishing, and social actions remain deferred and unavailable.

## Milestone 8 social review

After the independent final-article gate and verified publication, social items receive their own platform-level Telegram controls. Signed, expiring `s:` callbacks approve, hold, reject, open bounded previews/quality, or begin expiring input for changes, schedule time, and manual post URL. Approval only creates public-safe exports; it never posts. See `docs/17_SOCIAL_CONTENT_PIPELINE.md`.

## Milestone 9 analytics review

Authorized aggregate commands and signed, versioned `i:` insight actions are documented in `docs/18_ANALYTICS_AND_FEEDBACK_LOOP.md`. Analytics review never substitutes for topic approval or final article approval. Accepting an insight records future consideration only and cannot alter configuration.
