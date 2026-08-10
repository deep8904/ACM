# Token and Model Strategy

Milestone 6 incurs no model API cost. Deterministic review is local; Deep manually uses the existing Claude Code subscription with compact generated tasks and imports strict JSON. The provider interface is unimplemented, and no AI SDK is installed.

## 1. Constraint

The project should not require paid API services beyond tools already available to the user. Subscription access does not always include unrestricted API access, so implementation must verify how Claude and Gemini can be invoked in automation.

Claude Code running interactively is not equivalent to a server-side Claude API key. Gemini subscription access is also not automatically an API entitlement.

Therefore, the architecture must support two modes:

### Assisted mode

Automation collects, scores, and prepares compact task packets. Claude Code or Gemini is invoked manually for the final AI steps. This preserves zero additional spend.

### API mode

If the user later has included or approved API access, adapters can run fully unattended.

The MVP must not assume paid API credentials exist.

## 2. Token minimization

### Deterministic first

Do not use an LLM to:

- Parse RSS.
- Normalize URLs.
- Filter by date.
- Detect exact duplicates.
- Count sources.
- Check frontmatter.
- Format MDX.
- Generate slugs.
- Calculate basic scores.
- Validate JSON.

### Batch classification

Send compact records for multiple candidate topics in one model call rather than one call per item.

### Progressive context

Use this context order:

1. Topic summary.
2. Selected source notes.
3. Claim table.
4. Only the relevant brand sections.
5. Output schema.

Do not send the entire documentation repository to every call.

### Cache

Cache:

- Extracted source text by content hash.
- Source summaries.
- Topic clusters.
- Research packets.
- Brand profile.
- Published article embeddings or compact summaries.
- Social packages.

### Reuse

One approved article should drive:

- SEO metadata.
- LinkedIn.
- X.
- Instagram.
- Medium.

Do not research separately for each platform.

## 3. Model allocation

### Claude

Use for:

- Final topic angle when nuanced.
- Research synthesis.
- Long-form article writing.
- Editorial revision.
- Complex technical explanation.

### Gemini

Use for:

- Batch topic summaries.
- Short social variants.
- Carousel scripts.
- Visual concepts and image generation.
- Optional second-pass factual comparison.

### No-model stages

Use TypeScript for discovery, storage, scoring, validation, publishing, scheduling, and notifications.

## 4. Context budgets

Recommended internal limits:

- Candidate ranking packet: compact JSON, maximum 20 candidates.
- Research synthesis: selected sources only, not every raw page.
- Article packet: research summary plus claim table and key excerpts.
- Social packet: final article summary and platform rules.
- Revision packet: current draft plus user instruction, not full raw research unless required.

## 5. Human fallback

When no API access is available, the system should create task files such as:

- `tasks/ready-for-claude/topic-id.md`
- `tasks/ready-for-gemini/article-id-social.md`

The user can run a documented Claude Code command, and the output is then picked up by the next automation stage.

This still removes most manual work while respecting the no-extra-spend constraint.

Milestone 5 implements that fallback as `data/tasks/writing/<topicId>/v<researchVersion>/`. Preparation and validation are deterministic TypeScript, Claude Code is run manually under the user's existing subscription, and no Anthropic, Gemini, OpenAI, embedding, or other paid model SDK is installed or called. A provider-neutral future interface exists without an implementation.

Milestone 8 uses the same zero-API-budget pattern under `data/tasks/social/`. Claude Code is the manual choice for nuanced LinkedIn, X, and Medium adaptation; Gemini may manually produce short variants, carousel scripts, visual concepts, and safe image prompts. Imports are strict JSON. The application invokes neither provider and never invokes image generation.

Milestone 9 keeps the zero-API-budget boundary. Deterministic reports need no model. Optional advisory analysis creates a bounded aggregate-only task under `data/tasks/analytics/` for manual use with Claude Code or Gemini, then strictly imports the result. No SDK, API call, ranking update, or autonomous experiment exists.
