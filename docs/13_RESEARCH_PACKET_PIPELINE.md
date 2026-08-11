# Research Packet Pipeline

Milestone 4 consumes one approved-topic event and stops at a versioned, source-backed research packet. It never drafts an article, requests final article approval, publishes, or invokes an AI API.

## Boundary and lifecycle

`TopicApprovedEvent` files remain immutable. A local/private sidecar records the event claim and consumption only after the packet file and latest-version index are written. Jobs are claimed exclusively, retain retry history, can recover an abandoned claim, and check queue cancellation/supersession before resolution, each retrieval, analysis, and persistence. Replaying a consumed event creates neither a new job nor duplicate packet.

Ranked topics resolve only the immutable source IDs carried by the event and prefer primary sources. Manual URLs pass the same DNS/redirect URL safety policy. Manual topics without a URL produce an insufficient packet and an assistance task; they do not trigger open-ended browsing.

## Retrieval and privacy

Every request and redirect is restricted to HTTP(S), safe ports, and public DNS addresses. Responses have time, redirect, size, and content-type limits. No cookies, credentials, browser automation, paywall bypass, or authenticated pages are used. HTML boilerplate and hidden/script content are removed. HTML, XHTML, text, JSON, and XML are supported; PDF is metadata-only in this milestone. `robots.txt` rules are conservative and independently testable; a blocked page must fall back to metadata.

Full extracted text and caches live under ignored `data/research/` with mode `0600`. Packets contain short selected excerpts (400 characters each by default), source identifiers, evidence mappings, content hashes, warnings, conflicts, and explicit unknowns. Sensitive query parameter names are removed before URL persistence. Logs must use IDs, hostnames, stages, and error categories—not page bodies, Telegram text, or secrets.

Production execution fails closed until a private durable implementation of the research repository interfaces is configured. Local file repositories are for local development and offline validation only.

## Deterministic mode

Deterministic mode retrieves, extracts, summarizes, identifies conservative factual candidates, builds a source-date timeline, flags numeric disagreements, and calculates a transparent 0–100 sufficiency score. Primary-source absence, missing supported facts, community-only evidence, and unresolved blocking conflicts prevent readiness. Insufficient evidence stops before drafting.

## Manual assisted workflow

No model is called by the application. To use an existing Claude Code or Gemini subscription manually:

1. Run `npm run research:event -- --event-id <eventId>` (or `npm run research:next`) in assisted mode.
2. Run `npm run research:task -- --topic-id <topicId>` (processing also creates this task automatically).
3. Open `data/tasks/research/<topicId>/research-assistance.md`.
4. Manually paste that compact task into Claude Code or Gemini.
5. Ask the model to return JSON only, matching `expected-output.schema.json`.
6. Save the JSON locally, outside Git.
7. Run `npm run research:import -- --topic-id <topicId> --file /absolute/path/to/result.json`.
8. Inspect with `npm run research:packet -- --topic-id <topicId>`.

Import validates topic/event/version identity, strict schema, duplicate claim IDs, source IDs, excerpt IDs, timestamps, confidence, and excerpt limits. It creates a new immutable packet version and records manual-import provenance. It cannot remove deterministic conflicts or self-declare readiness; the local sufficiency calculation remains authoritative. Consumption is recorded only after the imported packet persists.

### Extending evidence on a consumed topic

`research:add-source` is the underlying supported service path for attaching new public evidence after an approved event has been consumed. It requires the existing topic, public HTTP(S) URL, authority, source type, publisher name, and publisher-owner domain. The command validates URL ownership and authority combinations, rejects GitHub-owned documentation classified as independent, uses the normal DNS/redirect/robots/extraction safeguards, and atomically writes a new source plus a new immutable packet version. It never edits the approval event or an older packet.

Exact duplicate requests are idempotent. The same URL with conflicting metadata is rejected. Publisher diversity is scored by ownership, so `github.blog` and `docs.github.com` count as one GitHub-owned group. An extracted extension packet waits for assisted synthesis and remains ineligible for writing until a later supported import reaches the unchanged sufficiency threshold.

### Telegram-first blocked-research recovery

Migration 019 adds an actor-scoped, expiring research-remediation conversation and an immutable remediation audit stream. When a durable automation research job blocks because primary evidence was not retrieved, Telegram sends a compact `Research blocked` card with `Add primary source`, `Change topic`, `Cancel`, and `Details` actions.

If that card expires, `/jobs` shows only canonically active, recoverable research lineages with a signed, actor-scoped `Resume research` button. Resume issues a fresh durable remediation version and TTL without retrying research or changing sources. `/jobs all` keeps malformed, orphaned, superseded, and terminal automation history available for diagnostics without presenting it as operator work.

`Add primary source` accepts one public HTTP(S) URL through the existing DNS, redirect, port, private-network, robots, size, and extraction safeguards. Retrieval inspects the publisher and ownership group but writes no source or packet. Telegram always presents the detected publisher, ownership group, proposed authority, and reason before classification. A primary classification requires the operator to tap `Confirm primary`; an unknown owner defaults to `Treat as independent` and is never silently promoted.

Confirmation calls the same `ResearchService.extendSource` operation used by `research:add-source`. Its existing atomic extension repository supplies duplicate protection, immutable packet versioning, provenance, ownership validation, and content-hash identity. The webhook then enqueues an idempotent research-remediation automation job. The worker runs the existing Gemini synthesis/import path and unchanged sufficiency gates. A sufficient latest packet is discovered by the normal reconciler and queues writing; an insufficient result sends a new recovery card. No Telegram action in this flow approves or publishes an article.

`Change topic` and `Cancel` reuse topic and automation-job cancellation semantics. They update mutable control state only; approved events, research packets, automation jobs, remediation events, and historical downstream records are retained.

## Commands

- `research:next`: claim the next eligible event.
- `research:event -- --event-id <eventId>`: process one event.
- `research:status -- --event-id <eventId>`: inspect pending work or a job.
- `research:packet -- --topic-id <topicId> [--version N]`: inspect a packet.
- `research:task -- --topic-id <topicId>`: write the three assistance files.
- `research:import -- --topic-id <topicId> --file <result.json>`: validate and import manual synthesis.
- `research:retry -- --job-id <jobId>`: retry a failed job, or an assistance job whose immutable packet records a blocked/failed/unsupported retrieval. Healthy assistance jobs cannot be reclaimed.
- `research:add-source -- --topic-id <topicId> --url <httpsUrl> --authority <classification> --source-type <type> --publisher <name> --publisher-owner <domain>`: safely extend the latest packet for an already-consumed, still-approved topic.

The CLI source-extension command remains an operator/debugging fallback. Normal blocked-research recovery uses Telegram buttons and `/add_source <topicId>` only when the original card must be reopened.

Pass `--fixtures tests/fixtures/research` to processing commands for offline HTTP fixtures. Fixture mode maps URL host/path to files and performs no network access.

## Approval gates

Research requires Telegram topic approval. Milestone 4 produces no article. A future article must still pass the separate Telegram final article approval gate before any publication action.
