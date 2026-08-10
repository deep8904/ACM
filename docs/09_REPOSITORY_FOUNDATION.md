# Repository Foundation

Milestone 0 establishes the local application and engineering baseline. It intentionally does not implement trend ingestion, Telegram callbacks, research, writing, publishing, or social generation.

## Runtime

- Node.js 22 or newer.
- Next.js App Router with strict TypeScript.
- Zod for server-side environment parsing.
- ESLint and Prettier for static checks and formatting.
- Vitest for unit tests.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

The default `AI_MODE=assisted` does not require paid API access. Empty Telegram variables are accepted during Milestone 0 because the bot is not implemented until Milestone 3.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Formatting can be checked independently with `npm run format:check`.

## Approval invariant

Future pipeline stages must preserve both distinct states:

1. `AWAITING_TOPIC_APPROVAL` before research or article generation.
2. `AWAITING_FINAL_APPROVAL` before publication.

No automated path may bypass either gate. Milestone 0 displays and documents the invariant but does not implement Telegram behavior ahead of Milestone 3.
