# Claude Code Operating Instructions

## Project identity

You are implementing **AI Content Machine**, a trend-first publishing system for Deep's personal technology blog. The product must discover timely topics, create evidence-based research, draft authentic articles, ask for Telegram approval, publish approved MDX content, and prepare social media packages.

## Mandatory reading order

Before editing code:

1. Read `docs/00_PROJECT_BRIEF.md`.
2. Read `docs/01_PRODUCT_REQUIREMENTS.md`.
3. Read `docs/02_SYSTEM_ARCHITECTURE.md`.
4. Read `docs/03_IMPLEMENTATION_PLAN.md`.
5. Read every file in `brand/`.
6. Read the prompt and schema files related to the module being implemented.

## Product constraints

- Do not introduce paid SaaS dependencies unless the user explicitly approves them.
- Prefer GitHub Actions, local files, RSS, public APIs, Telegram Bot API, Next.js, MDX, and Vercel.
- Use Claude only for tasks requiring strong long-form reasoning or writing.
- Use Gemini for lower-cost summarization, social packaging, and image generation where possible.
- Never publish without explicit Telegram approval.
- Topic approval and final article approval are separate gates.
- The user must be able to add a custom topic or URL.
- Do not force a fixed category schedule.
- Skip publication when no candidate meets the quality threshold.
- Preserve source links and claim-level evidence.

## Engineering standards

- Use TypeScript with strict mode.
- Prefer small pure functions and explicit data contracts.
- Validate external data with Zod.
- Separate discovery, research, writing, review, publishing, social, and notification modules.
- Do not place provider-specific logic directly in business rules. Use adapters.
- Keep secrets in environment variables and document every required variable.
- Store run artifacts so failed jobs can resume without repeating expensive work.
- Make operations idempotent.
- Add structured logging with `runId`, `topicId`, `articleId`, and stage.
- Use retries only for transient failures, with exponential backoff and a hard limit.
- Never silently swallow errors.

## Content standards

- Primary sources outrank secondary reporting.
- Any important factual claim must be traceable to a source in the research packet.
- Never fabricate tests, hands-on experience, quotes, prices, specifications, dates, or benchmarks.
- A product review without first-hand testing must be labeled as a source-based review or buying analysis.
- Do not imitate another writer or publication.
- Do not use generic AI filler, inflated marketing language, or artificial enthusiasm.
- Follow `brand/writing-style.md` and `brand/editorial-rules.md`.

## Change discipline

For each milestone:

1. State the exact scope.
2. Inspect the current repository.
3. Implement only the milestone.
4. Add or update tests.
5. Run lint, typecheck, tests, and build.
6. Update documentation.
7. Summarize files changed, validation results, and remaining risks.

Do not make broad refactors unrelated to the current milestone.

## Git conventions

- Branches: `feature/<scope>`, `fix/<scope>`, or `docs/<scope>`.
- Commits: conventional, concise, and scoped.
- Examples:
  - `feat(discovery): add RSS ingestion and normalization`
  - `feat(telegram): add topic approval callbacks`
  - `docs(brand): define editorial voice`
- Never commit secrets, generated credentials, local databases, or `.env` files.

## Definition of done

A feature is done only when:

- Functional requirements are implemented.
- Error states are handled.
- Types and schemas are valid.
- Tests cover critical behavior.
- Documentation is updated.
- No paid dependency was introduced without approval.
- The approval workflow remains intact.
