# Trend Discovery, Research, and Scoring

Milestone 9 analytics may compare original deterministic scores with aggregate outcomes and suggest a manually reviewed experiment. It never rewrites weights, thresholds, source policy, or ranking history. Any future configuration change requires a separate explicit human-controlled workflow.

## 1. Discovery philosophy

The objective is not to collect the entire internet. It is to identify a manageable number of high-signal events early enough to publish useful analysis.

More feeds do not automatically improve results. The source set should be curated and measured.

## 2. Source groups

### Primary technology sources

Examples:

- Company newsrooms.
- Product blogs.
- Official documentation.
- Release notes.
- GitHub repositories and releases.
- Standards bodies.
- Regulatory filings when relevant.

### Community signals

Examples:

- Hacker News.
- Selected technology and gaming communities.
- GitHub discussions and issue velocity.
- Product Hunt launches.
- Developer forums.

Community signals indicate attention, not truth.

### Independent reporting

Use reputable technical publications and specialist outlets to identify context, criticism, and independent confirmation.

### Product research sources

For product analysis:

- Manufacturer specifications.
- Support documentation.
- Retail listings for availability, not unquestioned specifications.
- Independent lab testing.
- Long-term user reports.
- Warranty and return information.
- Known issue discussions.

## 3. Source configuration

A source entry should define:

```yaml
id: openai-news
name: OpenAI News
type: rss
url: https://example.com/feed.xml
authority: primary
topics:
  - ai
  - software
enabled: true
maxItems: 20
```

The actual source URL must be verified during implementation. Do not hardcode an assumed RSS URL without testing it.

## 4. Deterministic score

Suggested 100-point score:

- Freshness: 0-20
- Primary-source presence: 0-15
- Source diversity: 0-10
- Discussion velocity: 0-15
- Audience relevance: 0-15
- Analysis potential: 0-10
- Search shelf life: 0-10
- Original-angle opportunity: 0-5

Subtract:

- Rumor risk: 0 to -20
- Duplicate/recent coverage: 0 to -25
- Weak evidence: 0 to -20
- Saturation without differentiation: 0 to -10

The score must include a human-readable explanation.

## 5. Editorial selection rules

A high score does not automatically mean "write it." The shortlist should include a range of opportunity types:

- Major release with immediate impact.
- Technical change needing explanation.
- Product announcement with buying implications.
- Industry event with a useful contrarian or contextual angle.
- Gaming or design development relevant to the audience.

Avoid selecting four stories that are all minor model releases from the same company.

## 6. Research packet structure

```yaml
topic:
  id:
  approved_angle:
  user_notes:
summary:
timeline:
primary_sources:
secondary_sources:
community_sources:
facts:
claims:
counterpoints:
unknowns:
product_specs:
quotes:
article_recommendation:
research_confidence:
```

## 7. Claim-evidence mapping

Every important claim should have:

- Claim text.
- Claim type: fact, interpretation, prediction, opinion.
- Supporting source IDs.
- Confidence.
- Notes on disagreement.

Example:

```json
{
  "claim": "The update changes the default caching behavior.",
  "type": "fact",
  "sourceIds": ["official-release-notes"],
  "confidence": 0.98
}
```

Predictions must be clearly labeled and should not be stored as established facts.

## 8. Product review policy

The system must distinguish:

- Hands-on review: only when Deep provides actual experience and notes.
- Source-based review: analysis derived from specifications and credible external testing.
- Buying guide: comparison centered on user needs.
- First-look analysis: early announcement coverage with limited evidence.

Never write "I tested" or equivalent language unless Deep supplied first-hand evidence.

## 9. Research sufficiency gate

Drafting should be blocked when:

- No primary source exists for an announcement that should have one.
- Key specifications conflict and cannot be resolved.
- The topic is primarily rumor.
- The story lacks enough substance for the intended article.
- Source extraction failed for most essential evidence.
- The recommended angle would require unsupported assumptions.

The bot should explain the reason and offer options: wait, select another topic, or approve a narrower article.
