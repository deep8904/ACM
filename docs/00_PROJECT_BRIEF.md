# Project Brief

## 1. Product summary

AI Content Machine is a semi-autonomous content operation for Deep's personal technology brand. It behaves like a small editorial desk rather than a bulk AI writer. It watches public trend signals, identifies topics with meaningful audience demand, assembles research from credible sources, writes detailed articles in Deep's voice, and waits for approval before publication.

The system focuses on:

- New developments in computing and the technology industry.
- Product analysis and source-based reviews of keyboards, monitors, creator hardware, laptops, cameras, and similar equipment.
- Gaming, game design, game development, engines, and major industry news.
- Software engineering, developer tools, AI products, models, frameworks, and platform changes.
- Design tools, UI/UX, product design, creator workflows, and relevant creative technology.

These are editorial boundaries, not a rigid weekly rotation. The system should select the most important available topics across all areas.

## 2. Problem statement

Maintaining a useful technology blog requires repeated work:

- Monitoring many sources.
- Identifying what is genuinely important.
- Separating primary facts from repeated reporting.
- Researching context and implications.
- Writing original analysis.
- Producing platform-specific posts and visuals.
- Publishing at a useful time.
- Avoiding repetition and low-value content.

The user wants the system to complete nearly all of this work while preserving editorial control.

## 3. Product vision

Create a personal technology publication that readers trust because it is:

- Timely without being shallow.
- Technical without becoming inaccessible.
- Opinionated without becoming careless.
- Automated without sounding automated.
- Consistent without becoming repetitive.
- Broad enough to cover meaningful technology shifts while focused enough to build a recognizable audience.

## 4. User workflow

### Topic review

The system sends a Telegram message containing a small number of ranked opportunities. Each item includes:

- Proposed headline.
- One-sentence explanation.
- Why it is trending.
- Why it fits the audience.
- Freshness and confidence.
- Primary source count.
- Suggested article angle.
- Estimated shelf life.
- Risk flags.

The user can:

- Approve one or more topics.
- Reject a topic.
- Request replacement options.
- Add a custom topic.
- Paste a URL.
- Add editorial notes.

### Final review

After research and drafting, Telegram presents:

- Final title.
- Article summary.
- Source count.
- Key claims.
- Quality report.
- Preview link or file link.
- Social package summary.

The user can:

- Approve and publish.
- Approve the article but delay social posting.
- Request focused edits.
- Regenerate title or introduction.
- Reject the draft.
- Schedule publication.

## 5. Success criteria

The first production version succeeds when:

- Two publishable drafts can be produced per week.
- Human work stays below roughly fifteen minutes per article.
- Every article contains verifiable source references.
- The system avoids duplicate topics.
- No article publishes without approval.
- Failed runs can resume without starting over.
- Writing is recognizably consistent across articles.
- Social outputs are adapted, not copied from the article introduction.
- The system runs with no new recurring paid services.

## 6. Non-goals

Version 1 will not:

- Operate as a multi-author CMS.
- Publish dozens of low-cost SEO pages.
- Scrape paywalled sources.
- Bypass robots.txt or site restrictions.
- Automatically claim hands-on product experience.
- Automatically reply to social comments.
- Use hidden engagement tactics.
- Generate fake quotes, benchmarks, reviews, or user experiences.
- Guarantee traffic or search ranking.
