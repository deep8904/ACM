# Implementation Plan

## Principle

Build the smallest reliable vertical slice first. Do not implement analytics, multi-platform auto-posting, or a complex database before the core loop works.

## Milestone 0: Repository foundation

Deliverables:

- Next.js TypeScript project or integration plan for the existing blog.
- Strict TypeScript.
- ESLint and formatting.
- Zod.
- Environment variable validation.
- Structured logger.
- Test framework.
- Documentation index.
- Sample data.

Acceptance:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Milestone 1: Trend ingestion

Implement:

- Configurable RSS source list.
- Hacker News adapter.
- GitHub release or trending adapter where reliable.
- Raw item schema.
- URL normalization.
- Duplicate removal.
- Saved JSON output.
- Source-level error reporting.

Do not use AI in this milestone.

Acceptance:

- A local command collects recent items.
- One failed source does not fail the run.
- Re-running does not duplicate items.
- Fixtures cover RSS variations.

## Milestone 2: Story clustering and ranking

Implement:

- Similar-title grouping.
- Entity and keyword overlap.
- Deterministic scoring.
- Topic candidate schema.
- Recent-topic suppression.
- Optional batch AI editorial scoring behind an interface.

Acceptance:

- Sample duplicate stories cluster together.
- Old, low-authority stories rank below fresh primary-source stories.
- Output is capped and explainable.
- Every score includes a breakdown.

## Milestone 3: Telegram topic approval

Implement:

- Bot setup documentation.
- Webhook API route.
- Inline topic cards.
- Approve, reject, replace, add topic, add URL.
- Stable callback data.
- Approval persistence.
- Repository dispatch or workflow trigger.

Acceptance:

- User can approve a topic from Telegram.
- User can submit a URL.
- Invalid callbacks are rejected.
- Duplicate callback delivery is idempotent.

## Milestone 4: Research packet

Implement:

- Source selection.
- Primary-source requirement.
- Content extraction adapter.
- Research packet schema.
- Claim-evidence table.
- Research sufficiency score.
- Cache by canonical URL and content hash.

Acceptance:

- Approved topic produces a packet.
- Every key fact has one or more source IDs.
- Insufficient evidence blocks drafting.
- Cached sources are reused.

## Milestone 5: Claude writer

Implement:

- Prompt loader.
- Brand context selector.
- Article type selector.
- Structured MDX output.
- Frontmatter validation.
- Article history check.
- Draft persistence.

Acceptance:

- Draft is valid MDX.
- No unsupported claim intentionally appears in test fixtures.
- Article follows word-count and structure constraints.
- Claude call occurs only after approval and research.

## Milestone 6: Quality review and revision

Implement:

- Deterministic lint checks.
- Forbidden phrase checker.
- Citation coverage report.
- Separate editorial review prompt.
- Bounded automatic correction.
- Telegram preview and revision commands.

Acceptance:

- Unsupported claims are flagged.
- Reviewer cannot publish.
- User can request a targeted change.
- Revisions preserve article ID and version history.

## Milestone 7: Publishing

Implement:

- Blog repository adapter.
- Slug collision handling.
- MDX path rules.
- GitHub commit.
- Deployment status recording.
- Publication confirmation.

Acceptance:

- Approved draft becomes a committed article.
- Repeated publish callback does not duplicate the article.
- Failed deployment is reported.

## Milestone 8: Social package

Implement:

- LinkedIn output.
- X short post and thread options.
- Instagram carousel copy and visual brief.
- Medium adaptation.
- Gemini adapter.
- Social approval state.

Acceptance:

- Outputs are platform-specific.
- Claims match the article.
- User can select which platforms to use.
- No social post is made automatically in the default configuration.

## Milestone 9: Analytics feedback

Implementation status: complete in the local/fixture-safe boundary documented by `docs/18_ANALYTICS_AND_FEEDBACK_LOOP.md` and `docs/19_END_TO_END_OPERATIONS.md`.

- Search Console import.
- Basic traffic metrics.
- Topic performance history.
- Monthly editorial report.
- Weight recommendations, not self-modifying scoring.

The system should not automatically chase performance at the expense of editorial standards.

Milestone 9 is the final roadmap milestone. There is no Milestone 10. Live providers, production durability, and any configuration change remain explicit blockers or future human-controlled work, not implied completion.
