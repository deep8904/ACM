# Editorial Review and Final Approval

Milestone 6 adds a private editorial-review pipeline and the mandatory second Telegram gate. Final approval authorizes a future publisher; it does not publish, commit, deploy, generate social content or images, set publication metadata, or consume the handoff event.

## Architecture and lifecycle

The pipeline is `validated draft -> deterministic review -> manual Claude Code review import -> optional targeted revision -> new immutable draft -> new review -> local preview -> Telegram final approval -> unconsumed ArticleFinalApprovedEvent`. Milestone 7 is the only future consumer.

Provider-neutral repositories separate jobs, reviews/issues, revision tasks, previews, approvals, and final events from file adapters. Local writes are atomic, numbered versions are immutable, JSON is stable, and private files use mode `0600`. Production fails closed because local serverless disk is not a private durable backend.

`review:prepare` requires an explicit draft version. It accepts only the current validated unpublished draft, unchanged ready research packet, active topic approval, passing Milestone 5 quality, no conflicting job, and no existing approval. Replaying an awaiting task reuses it. Jobs move through claimed, preparing, awaiting manual review, importing, validating, and revision-required, ready, blocked, failed, or cancelled states.

## Checks and risk

Milestone 5 checks are reused. Additional checks cover headline/description scope, clickbait, first-hand claims, disclosures, introduction/conclusion, structure, counterpoints, uncertainty/conflicts, source attribution, predictions/opinions, certainty, relative time, price/availability, quotation limits, copied excerpts, headings/repetition, article type, metadata, and alt text.

Issues map to factual, source, legal/reputational, copyright, disclosure, timeliness, brand, technical, publication-readiness, and overall risk. Critical fabricated evidence, unknown sources, fake testing, unsafe MDX, missing disclosure, preset publication fields, and critical conflicts cannot be waived by an imported pass. Lexical checks are conservative and do not replace human semantic judgment.

## Manual review workflow

1. Run `npm run review:prepare -- --topic-id <id> --draft-version <n>`.
2. Open `data/tasks/review/<id>/draft-v<n>/editorial-review.md`.
3. Ask Claude Code to complete only the supplied task without browsing.
4. Save JSON outside Git.
5. Run `npm run review:import -- --topic-id <id> --draft-version <n> --file /absolute/result.json`.
6. Inspect `review:report` and its locally normalized decision.

The seven-file task has instructions, compact input, expected schema, full draft context, claim index, compact source index, and deterministic report. It excludes full source articles, credentials, Telegram IDs, unrelated drafts, and irrelevant notes.

Import validates strict schema, exact draft/packet versions and hashes, task hash, unique issue IDs, known source/claim/section IDs, supported numeric corrections, configured decisions, and deterministic blockers. Imported content is never executed. Exact import hashes are idempotent; changed imports create immutable review versions. The application reruns checks and normalizes pass, pass-with-warnings, revise, or block locally.

## Targeted revisions

Run `npm run revise:prepare -- --topic-id <id> --draft-version <n> --issue-ids <ids>`. The five-file task records scope, relevant issues, protected claims, field permissions, and schema. Claude Code must not browse or publish.

Import with `npm run revise:import -- --topic-id <id> --draft-version <n> --file /absolute/revision.json`. Scope/provenance, protected facts, required sources, and addressed issues are checked; MDX and Milestone 5 quality are recalculated. Persistence completes before issue-resolution metadata changes. A successful revision creates an immutable linked version and inherits neither review nor approval. Repeat review for the new draft.

## Preview privacy

`npm run preview:article -- --topic-id <id> --draft-version <n>` writes a deterministic local static preview beneath ignored private state. Only current validated safe MDX is accepted; imported markup is escaped into inert text. The `0600` artifact has no public URL, source bodies, or Telegram identifiers. Cancelled/superseded drafts fail. Expiry is recorded in metadata; production remains closed.

## Telegram final gate

Authorization and processed-update idempotency are unchanged. Final commands are separate: `/drafts`, `/review <topicId>`, `/article <topicId>`, `/approve_article <topicId>`, `/schedule_article <topicId> <date-time>`, `/changes <topicId>`, `/hold_article <topicId>`, and `/reject_article <topicId>`.

Cards contain only title and summary metrics: exact versions, article type, length, research version, normalized decision, citation coverage, source count, risk, issue counts, preview location, and later social eligibility. They never include the body. Buttons cover approval, scheduling, changes, hold, reject, cancel, issues, sources, quality, title request, and introduction request.

Final callbacks use a distinct signed `a:<action>:<short-id>:<version>:<signature>` namespace. They include no title, URL, notes, body, or private metadata. HMAC, optimistic version, and expiry checks reject tampered/stale actions. Topic `t:` callbacks cannot approve articles. Separate bounded conversation records collect schedule times, change requests, rejection reasons, or approval notes; there is no conversational AI agent.

## Approval, scheduling, cancellation, events

Approval rechecks exact draft/review identity, normalized pass/pass-with-warnings, no blockers/critical risk, citation and MDX safety, unpublished fields, active topic, unchanged ready packet, current draft, and no pending revision. Approval records contain no article body.

A local schedule datetime uses `America/Phoenix` (UTC-07:00); an offset datetime preserves explicit-offset semantics. UTC is stored. Impossible, past, and out-of-horizon times fail. Rescheduling versions the approval and safely updates the same logical unconsumed event.

Approval creates exactly one logical `ArticleFinalApprovedEvent`, freezes the exact draft/review snapshot hash, records source IDs and origin, and leaves it ready or scheduled and unconsumed. Duplicate processed updates/callbacks are idempotent. Cancellation versions approval/event without deleting history. Until later orchestration exists, use `final-approval:cancel` if a topic is cancelled after approval.

## CLI, configuration, and boundary

Commands: `review:prepare`, `review:status`, `review:task`, `review:import`, `review:report`, `revise:prepare`, `revise:import`, `preview:article`, `final-approval:status`, `final-approval:approve`, `final-approval:schedule`, and `final-approval:cancel`. `--fixtures <root>` redirects state to an offline tree. CLI summaries do not print bodies; Telegram remains the intended operator gate.

Configuration is in `automation/config/review.example.yaml`. Roots are `REVIEW_STATE_DIRECTORY`, `REVIEW_TASK_DIRECTORY`, `REVISION_TASK_DIRECTORY`, `FINAL_APPROVAL_STATE_DIRECTORY`, and `ARTICLE_EVENT_DIRECTORY`. No model SDK or paid service is installed/called. `EditorialReviewerProvider` is only a future boundary.

Known limits: semantic checks are lexical; local files do not provide multi-host transactions; Phoenix has no daylight-saving transition; expiry has no background deletion job; cancellation propagation is explicit. These limits are why production remains fail-closed and why Milestone 7 has not begun.
