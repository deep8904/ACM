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

`research:add-source` is the only supported path for attaching new public evidence after an approved event has been consumed. It requires the existing topic, HTTPS URL, authority, source type, publisher name, and publisher-owner domain. The command validates URL ownership and authority combinations, rejects GitHub-owned documentation classified as independent, uses the normal DNS/redirect/robots/extraction safeguards, and atomically writes a new source plus a new immutable packet version. It never edits the approval event or an older packet.

Exact duplicate requests are idempotent. The same URL with conflicting metadata is rejected. Publisher diversity is scored by ownership, so `github.blog` and `docs.github.com` count as one GitHub-owned group. An extracted extension packet waits for assisted synthesis and remains ineligible for writing until a later supported import reaches the unchanged sufficiency threshold.

## Commands

- `research:next`: claim the next eligible event.
- `research:event -- --event-id <eventId>`: process one event.
- `research:status -- --event-id <eventId>`: inspect pending work or a job.
- `research:packet -- --topic-id <topicId> [--version N]`: inspect a packet.
- `research:task -- --topic-id <topicId>`: write the three assistance files.
- `research:import -- --topic-id <topicId> --file <result.json>`: validate and import manual synthesis.
- `research:retry -- --job-id <jobId>`: retry a failed job, or an assistance job whose immutable packet records a blocked/failed/unsupported retrieval. Healthy assistance jobs cannot be reclaimed.
- `research:add-source -- --topic-id <topicId> --url <httpsUrl> --authority <classification> --source-type <type> --publisher <name> --publisher-owner <domain>`: safely extend the latest packet for an already-consumed, still-approved topic.

Pass `--fixtures tests/fixtures/research` to processing commands for offline HTTP fixtures. Fixture mode maps URL host/path to files and performs no network access.

## Approval gates

Research requires Telegram topic approval. Milestone 4 produces no article. A future article must still pass the separate Telegram final article approval gate before any publication action.
