# Article writing pipeline (Milestone 5)

Milestone 5 converts one explicitly selected, ready research packet into a validated article draft. It does not call a model, request final approval, publish, create social content, or generate images. Claude Code is the manual bridge: the application prepares bounded files, a person runs the writing task, and the application imports strict JSON.

## Approval and evidence gates

Both preparation and import require an explicit positive research-packet version. That exact packet must exist, be `ready` and sufficient, and contain no blocking reasons. Its topic-approved event must remain `ready`; its Telegram queue record must remain approved and ready; and the candidate, event, packet ID, version, and content hashes must still match. A conflicting active writing job blocks preparation. A newer ready packet produces a warning, but the task stays pinned to the selected version.

The imported artifact remains `draft: true`, `status: draft` in frontmatter, and `Not editorially reviewed or approved`. Milestone 5 contains no path around the future Telegram final-article approval gate. Production execution fails closed while this implementation uses private local files rather than a configured durable private backend.

## Manual workflow

Prepare one task:

```bash
npm run write:prepare -- --topic-id <topicId> --research-version <n>
```

This writes five bounded files under `data/tasks/writing/<topicId>/v<n>/`: `article-writing.md`, `writing-input.json`, `expected-output.schema.json`, `source-index.json`, and `claim-index.json`. Open the task in Claude Code, follow it without browsing or modifying the project, save only the returned JSON, then import it:

```bash
npm run write:import -- --topic-id <topicId> --research-version <n> --file ./writer-result.json
```

Inspection and lifecycle commands are:

```bash
npm run write:status -- --topic-id <topicId> --research-version <n>
npm run write:task -- --topic-id <topicId> --research-version <n>
npm run write:draft -- --topic-id <topicId> --version <draftVersion>
npm run write:quality -- --topic-id <topicId> --version <draftVersion>
npm run write:retry -- --job-id <writingJobId>
npm run write:cancel -- --job-id <writingJobId>
```

No command sends article text to logs except explicitly requested draft or task inspection.

## Validation boundary

The importer validates strict structured output, identity and provenance, controlled category and tags, deterministic slug rules, title/history overlap, article structure, source IDs, research claim IDs, support relationships, inline citation markers, disclosures, and first-hand-experience claims. Standard Markdown and fenced code are allowed. Writer-supplied frontmatter, imports, exports, JSX, executable expressions, raw HTML, scripts, event handlers, dangerous URL schemes, private-network URLs, credential-bearing URLs, and path traversal are blocked.

Critical facts, specifications, timelines, and quotations carry more citation weight than analysis. Unsupported references, unknown IDs, incompatible support mappings, uncited critical references, unsafe MDX, clickbait titles, or missing source-based review disclosure block persistence. Word count, structure, repetition, and non-factual style findings remain visible warnings for the future editorial stage.

## Persistence and idempotency

Jobs live under `data/writing/jobs/`. Successful imports produce immutable version directories under `data/writing/drafts/<topicId>/v<n>/`, each with `draft.json`, `article.mdx`, `plain-text.txt`, `quality-report.json`, and `import-provenance.json`. A staging-directory rename prevents partial bundles. Identical input hashes replay idempotently; changed imports receive a new draft version and identify the predecessor. Deterministic history uses titles, slugs, topic IDs, keywords, summaries, article types, and research hashes—no embeddings or paid services.

Schemas are generated from strict runtime models with `npm run schemas:writing` into `automation/schemas/`. The interface is provider-neutral, but Milestone 5 wires only `manual_claude_code`.

## Validation

Run `npm run schemas:writing`, `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev`, `npm audit --audit-level=high`, and `npm ls --depth=0`.

Tests cover strict schemas, adversarial MDX, fenced code, eligibility failure, task preparation, successful import, immutable persistence, review disclosure, and replay-safe import.
