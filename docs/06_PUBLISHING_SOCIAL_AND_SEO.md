# Publishing, Social Distribution, and SEO

Milestone 6 implements none of this publication stage. Final approval or scheduling only writes an immutable, unconsumed handoff event. Git commits, deployment, canonical URLs, publication dates, social output, and images remain Milestone 7 work.

## 1. Blog platform

The target is a Next.js blog using MDX content, hosted on Vercel, with source stored in GitHub.

The automation should adapt to the existing blog structure rather than forcing a new content framework.

## 2. MDX frontmatter

Recommended fields:

```yaml
title:
slug:
description:
publishedAt:
updatedAt:
status:
category:
tags:
author:
heroImage:
heroAlt:
canonicalUrl:
sources:
draft:
```

Additional optional fields:

- `articleType`
- `readingTime`
- `featured`
- `socialImage`
- `reviewDisclosure`
- `productData`

## 3. Article path

Use a predictable path, for example:

`content/blog/YYYY/article-slug.mdx`

The publisher must detect slug collisions.

## 4. Citation strategy

Use readable inline links or numbered references depending on the existing site design. Sources should be visible and useful, not hidden only in metadata.

For news and analysis, link the primary source early.

For product content, include a methodology or disclosure when the analysis is not hands-on.

## 5. SEO principles

The system should optimize clarity, not manipulate search engines.

Required:

- Accurate headline.
- Distinct title and meta description.
- Canonical URL.
- Open Graph metadata.
- Article structured data where appropriate.
- Descriptive image alt text.
- Sitemap inclusion.
- Internal links to relevant existing posts.
- Clean URL.
- Updated timestamp only when content materially changes.

Avoid:

- Keyword stuffing.
- Artificial FAQ sections with no reader value.
- Misleading freshness updates.
- Clickbait titles.
- Duplicate Medium content without canonical handling.

## 6. Medium strategy

Medium can expand reach, but publishing identical text immediately may create ambiguity.

Recommended options:

- Publish a shortened adaptation with a clear link to the original.
- Delay full syndication.
- Set canonical link when Medium supports it in the chosen workflow.
- Use a platform-specific introduction and conclusion.

Version 1 should generate the Medium package and let the user publish manually.

## 7. LinkedIn

Recommended frequency: one or two high-value posts per week.

Structure:

- Strong factual or opinion-led opening.
- Short paragraphs.
- One central insight.
- A few concrete takeaways.
- Link to the article.
- No forced engagement question.
- Minimal emojis.

## 8. X

Generate two options:

- Single concise post.
- Thread of four to eight posts.

The thread should not merely split article paragraphs. It should have its own narrative.

## 9. Instagram

Generate:

- Carousel headline.
- Six to eight slide scripts.
- Visual instructions per slide.
- Caption.
- Alt text.
- Relevant hashtags, kept limited.

Gemini image generation may create visual assets, but the design must follow `brand/design-style.md`. Generated imagery must not falsely depict unreleased physical products as real photographs.

## 10. Social scheduling

Milestone 8 uses configurable `America/Phoenix` windows to suggest exact future times and lets the user override each platform. These are suggestions, not claims of optimal performance. Scheduling records do not post or confirm platform-native scheduling. Milestone 9 reports aggregate outcomes but makes no automatic scheduling or optimization change.

Do not claim a universal "best time." Start with reasonable windows in the user's timezone and learn from actual performance.

## Milestone 5 boundary

Milestone 5 creates only a validated MDX draft with null publication and canonical fields, no image, and an explicit “not editorially reviewed or approved” disclosure. It does not run this document's publishing, final Telegram approval, Medium, social, image, scheduling, or analytics workflows. Those remain blocked until later milestones and an explicit final-article approval.

## Milestone 8 boundary

Social generation is a deterministic task plus strict manual Claude Code/Gemini import based on one exact verified publication. It produces platform-specific text, textual visual briefs, safe image-prompt packages, quality reports, signed Telegram approvals, and manual exports. No image generation or live posting runs. Milestone 9 may read only verified publication and confirmed-post records for aggregate reporting.
