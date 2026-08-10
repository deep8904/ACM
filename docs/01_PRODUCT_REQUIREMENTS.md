# Product Requirements

## 1. Personas

### Primary operator

Deep is the owner, editor, and final approver. He wants a content machine that runs with minimal intervention while keeping his personal identity and judgment visible.

### Reader segments

The publication serves overlapping groups:

- Software developers and technical students.
- UI/UX and product designers.
- Creators and technically curious professionals.
- Gamers and people interested in game development.
- Buyers researching practical technology products.
- Readers trying to understand why a new release matters.

The default reading level should be accessible to an informed general technology audience. Advanced sections may be technical, but unexplained jargon should be avoided.

## 2. Functional requirements

### FR-1 Trend collection

The system shall collect recent items from configurable feeds and public endpoints, including official company blogs, release notes, Hacker News, relevant subreddits or RSS feeds, GitHub activity, gaming publications, design sources, and general technology news.

Each collected item shall include:

- Source name.
- Source type.
- URL.
- Title.
- Published time when available.
- Retrieved time.
- Short raw summary when available.
- Category hints.
- Source authority level.

### FR-2 Normalization and deduplication

The system shall:

- Normalize URLs.
- Remove tracking parameters.
- Detect duplicate URLs.
- Group stories describing the same event.
- Preserve all unique source references within a story cluster.
- Avoid recommending recently published or rejected topics unless substantially updated.

### FR-3 Topic scoring

Each topic cluster shall be scored using:

- Freshness.
- Number and diversity of independent sources.
- Presence of a primary source.
- Discussion velocity.
- Relevance to the publication audience.
- Explanatory or analytical potential.
- Long-term search value.
- Competitive saturation.
- Original angle potential.
- Risk of rumor or incomplete information.

AI may assist with qualitative scores, but deterministic signals should be calculated in code where possible.

### FR-4 Topic approval

The Telegram interface shall support:

- Viewing ranked topic cards.
- Approving one or multiple topics.
- Rejecting topics.
- Requesting alternatives.
- Adding a topic as plain text.
- Adding a URL.
- Adding notes to an approved topic.
- Viewing the current queue.
- Cancelling a topic before publication.

### FR-5 Research packets

For every approved topic, the system shall generate a research packet containing:

- Topic definition and scope.
- Primary source summary.
- Secondary source summary.
- Timeline.
- Key facts.
- Claims and evidence mapping.
- Important technical details.
- Community sentiment samples.
- Counterarguments and limitations.
- Open questions.
- Suggested article angle.
- Source list with retrieval timestamps.

### FR-6 Article generation

Claude shall create an article from the research packet and brand files. The article must:

- Use original structure and phrasing.
- Explain why the topic matters.
- Distinguish facts from analysis.
- Include limitations or uncertainty.
- Avoid unsupported certainty.
- Include source links in a consistent citation format.
- Produce valid MDX.
- Generate frontmatter.
- Avoid unnecessary repetition.
- Follow the selected article type.

### FR-7 Article review

The review stage shall check:

- Claim support.
- Source quality.
- Date consistency.
- Product specification consistency.
- Originality of framing.
- Writing style.
- Repetition.
- AI-cliché language.
- Headline accuracy.
- SEO basics.
- MDX validity.
- Legal or reputational risk indicators.

The system must not pretend an automated score guarantees correctness.

### FR-8 Publishing

After final approval, the system shall:

- Create or update an MDX article.
- Add approved metadata.
- Save image assets or image instructions.
- Commit changes to the configured blog repository.
- Trigger the existing Vercel deployment.
- Record publication state and commit SHA.
- Confirm deployment status when available.

### FR-9 Social output

For approved articles, the system shall generate:

- LinkedIn post.
- X post or thread.
- Instagram carousel copy and caption.
- Medium adaptation plan or draft.

Social content shall not automatically publish in version 1 unless the platform integration is reliable and approved. The preferred initial model is generate, review, then manually post or use platform-native scheduling.

### FR-10 Custom topic and URL ingestion

A manually supplied URL shall bypass trend selection but not research, verification, writing, or approval requirements.

A manually supplied topic shall be researched before drafting.

## 3. Non-functional requirements

### Reliability

- Every stage must be idempotent.
- Network calls must use timeouts.
- Transient calls may retry with bounded exponential backoff.
- State must be saved after each stage.
- A failure must not publish partial content.

### Security

- Secrets must use GitHub Actions secrets or Vercel environment variables.
- Telegram webhook requests must be authenticated or protected by a secret path.
- User-provided URLs must be validated.
- The system must block localhost, private-network, and metadata-service URLs to reduce SSRF risk.
- Logs must not contain tokens or full credentials.

### Maintainability

- Provider adapters must be replaceable.
- Data contracts must be versioned.
- Prompts must be stored as files.
- Scoring weights must be configurable.
- Source lists must be configurable without code changes where possible.

### Cost control

- No new required paid service.
- AI work must be gated after deterministic filtering.
- Research must be cached.
- Social generation should reuse the final article and research packet.
- Duplicate stories must not be summarized repeatedly.
