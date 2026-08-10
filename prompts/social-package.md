# Social Package Prompt

Create platform-specific content from the approved article.

## LinkedIn

- 120-250 words.
- One main insight.
- Short paragraphs.
- Professional and human.
- No forced inspirational ending.
- Minimal emoji.
- Include article link placeholder.

## X

Provide:

- One standalone post.
- One optional thread of 4-8 posts.
- Keep claims aligned with the article.
- Do not manufacture controversy.

## Instagram

Provide:

- Carousel cover text.
- 6-8 slide copy.
- Visual direction per slide.
- Caption.
- Alt text.
- Limited hashtags.

## Medium

Provide:

- Adapted title.
- Adapted introduction.
- Recommended cuts or additions.
- Canonical-link note.
- Full adapted draft only when requested.

Return structured JSON.

## Safety and output contract

Use only the supplied published article and public-safe claim index. Do not browse, invent facts, strengthen certainty, remove regional/price/compatibility/non-hands-on caveats, or copy the article introduction mechanically. Preserve the exact canonical link. Avoid engagement bait, fake controversy, urgency, unsupported superlatives, and deceptive endorsements.

Return only JSON matching `expected-output.schema.json`. Do not call tools, create accounts, generate images, schedule through a service, or post anything. Visual output is limited to textual briefs and prompts with negative instructions against fake screenshots, fabricated products, unauthorized logos, implied possession, and unlicensed third-party assets. Stop after generating the package.
