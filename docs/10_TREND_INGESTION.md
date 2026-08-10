# Trend Ingestion

Milestone 1 adds deterministic collection of recent source items. It does not call Claude, Gemini, or any other model, and it does not fetch article pages.

## Architecture

The discovery pipeline is split into replaceable layers:

1. The YAML configuration loader validates source definitions with Zod.
2. `TrendSourceAdapter` selects provider-specific collection behavior.
3. RSS/Atom and Hacker News adapters return the shared `SourceItem` contract.
4. URL normalization and exact duplicate removal run as pure functions.
5. The discovery service isolates source failures and records structured results.
6. Persistence atomically writes three JSON artifacts for the run.

Provider logic does not live in orchestration or business rules. Fetch, clocks, sleeps, logging, and adapters are injectable so tests do not require the internet.

## Supported sources

- RSS 2.0 feeds.
- Atom feeds.
- Hacker News `top`, `new`, and `best` story lists through the public API.

The feed adapter reads feed metadata only. It never opens item links or renders embedded HTML. The Hacker News adapter uses at most five concurrent item requests and retries transient failures twice with bounded backoff.

## Configuration

Source files use this shape:

```yaml
sources:
  - id: github-changelog
    name: GitHub Changelog
    type: rss
    url: https://github.blog/changelog/feed/
    authority: primary
    topics: [software, developer-tools]
    enabled: true
    maxItems: 20
    timeoutMs: 10000
    language: en
```

`type` is `rss`, `atom`, or `hacker-news`. `authority` is `primary`, `independent`, `community`, or `aggregator`. Hacker News sources may set `mode` to `top`, `new`, or `best`.

Defaults are:

- `topics: []`
- `enabled: true`
- `maxItems: 20`, capped at 100
- `timeoutMs: 10000`, capped at 30 seconds
- `language: en`
- `mode: top`

Invalid URLs, duplicate source IDs, unknown enum values, and unsafe limits fail before fetching. Disabled sources are not passed to an adapter.

`automation/config/sources.example.yaml` contains the verified public starter configuration. The two enabled feeds returned RSS with HTTP 200 during Milestone 1 validation on August 6, 2026. Disabled `example.com` entries are placeholders and must be replaced and verified before enabling.

## CLI

Run configured public sources:

```bash
npm run discover
```

Optional parameters:

```bash
npm run discover -- \
  --config automation/config/sources.example.yaml \
  --run-id run_20260806_manual \
  --lookback-hours 72 \
  --max-items 20 \
  --output data/runs
```

Run entirely against repository fixtures:

```bash
npm run discover -- \
  --config automation/config/sources.fixtures.yaml \
  --fixtures tests/fixtures/http \
  --run-id run_20260806_fixture
```

Fixture mode blocks hosts other than `fixtures.local`, making it suitable for repeatable local validation.

## Output files

Each new run atomically writes:

```text
data/runs/<runId>/raw-items.json
data/runs/<runId>/normalized-items.json
data/runs/<runId>/discovery-report.json
```

`raw-items.json` contains validated adapter output before cross-source duplicate removal. `normalized-items.json` contains deterministic exact deduplication output. The report contains source durations, counts, warnings, failures, and duplicate reasons. Re-running a completed run ID validates and reuses its artifacts byte-for-byte instead of fetching or appending records. Use a new run ID to collect again.

Generated run directories remain ignored by Git.

## Error handling

- A source-list or feed-level failure marks that source as failed and does not stop other sources.
- Malformed RSS or Atom entries become warnings while valid siblings are retained.
- Deleted, dead, and non-story Hacker News items are ignored.
- Individual Hacker News item failures become warnings.
- Requests use timeouts, response-size limits, content-type checks, and bounded redirects.
- Summaries have scripts, styles, comments, and markup removed. Source HTML is never executed.
- Logs include `runId`, stage, source provider, and duration without credentials or response bodies.

## Security limitations

Milestone 1 reads operator-controlled configuration, not user-submitted URLs. It permits HTTP and HTTPS sources but does not yet resolve DNS and block private or reserved networks. That stronger SSRF protection is mandatory before custom URL ingestion. Redirects are limited to three for feeds and two for Hacker News, but redirect targets are subject to the same operator-trust assumption.

The ingestion layer does not bypass authentication, paywalls, robots.txt, or access controls and does not scrape article pages.

## Adding an adapter

1. Add a source type to the Zod enum.
2. Implement `TrendSourceAdapter` and declare `supportedTypes`.
3. Use the shared bounded HTTP helper or an equally bounded injectable transport.
4. Normalize every result with `createSourceItem`.
5. Register the adapter in the CLI.
6. Add local fixtures for successful, malformed, and partial-failure behavior.

## Deferred to Milestone 2

Milestone 1 performs exact deduplication only. Semantic title similarity, entity overlap, story clustering, scoring, recent-topic suppression, and editorial ranking are intentionally not implemented. Telegram approvals remain a separate Milestone 3 gate.
