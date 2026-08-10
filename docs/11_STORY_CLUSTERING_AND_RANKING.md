# Story Clustering and Ranking

Milestone 2 turns normalized discovery items into explainable topic candidates without calling an AI model. It does not implement Telegram approval, research, writing, publishing, or social generation.

## Architecture

The ranking pipeline consumes `normalized-items.json` and runs six deterministic stages:

1. Normalize titles and extract keywords, entity hints, product identifiers, event terms, and rumor hints.
2. Calculate pairwise similarity from multiple visible features.
3. Build guarded story clusters and stable fingerprints.
4. Compare clusters with file-backed topic history.
5. Calculate eight positive score components and six penalties.
6. Atomically persist clusters, candidates, ranked/suppressed views, a report, and a compact optional editorial packet.

Fetches, embeddings, vector databases, and model SDKs are not used.

## Data models

`StoryCluster` preserves every original source item ID, source and authority counts, primary items, independent publishers, extracted features, timestamps, discussion signals, confidence, merge reasons, and a stable fingerprint.

`TopicCandidate` contains the cluster relationship, deterministic angle, complete score breakdown, penalties, risks, selection and rejection reasons, shelf-life estimate, evidence label, and status. `pending` means eligible for a future approval stage; it does not constitute approval.

`DiscussionSignal` is provider-neutral. Milestone 2 normalizes Hacker News score, descendants, item age, and velocity. Future providers can populate the same model.

## Title normalization

Titles are decoded, normalized with Unicode NFKC, lowercased for comparison, and reduced to stable whitespace and punctuation. Configured `Breaking:`, `Update:`, and `Official:` prefixes are removed. Publisher suffixes are removed only from the configured safe list.

Technical identifiers remain intact, including `GPT-5`, `RTX 5090`, `Next.js 16`, `iOS 26`, `C++`, and `.NET`. Negation is not removed.

## Keywords and entity hints

Title terms receive weight 3 and summary terms weight 1. Configured entity phrases receive weight 8 so multiword names survive the limited keyword list. Stop words, entity aliases, rumor phrases, event terms, and relevance weights live in `automation/config/ranking.example.yaml`.

Entity extraction is a phrase-and-pattern hint system, not named-entity recognition. Product/version patterns supplement configured organization, product, framework, language, engine, and hardware aliases.

## Similarity

Pairwise similarity combines:

- Normalized title overlap: 34%.
- Ranked keyword overlap: 16%.
- Entity overlap: 14%.
- Product/version identifier overlap: 18%.
- Event-family overlap: 10%.
- Summary overlap: 3%.
- Publication-time proximity: 5%.

The result contains a numeric score and human-readable reasons. Configured event groups treat `launch`, `release`, and `available` as one release family while distinguishing security updates and previews.

Safeguards cap similarity when product identifiers conflict, event families conflict, a shared organization is the only meaningful match, or opinion/announcement framing differs.

## Clustering strategy

Items are processed in stable input order with greedy complete-link validation. A candidate must:

1. Meet the threshold against the cluster representative.
2. Meet `threshold × completeLinkRatio` against every cluster member.

This blocks transitive bridge merging: A may match B and B may match C, but C cannot join when A and C do not describe the same event. It is intentionally more conservative than connected components.

Representative-title order is primary source, higher authority, title quality, then earliest timestamp/input order. All-caps, question-only, truncated, and excessive-punctuation titles are penalized.

## Source independence

Raw source count and independent publisher count are separate. Primary and independent sources count once per configured publisher group or source/domain identity. Community and aggregator entries do not create primary confirmation. Multiple feeds can be grouped under one publisher in configuration.

## Scoring formula

Positive components total 100:

- Freshness: 20.
- Primary-source presence: 15.
- Source diversity: 10.
- Discussion velocity: 15.
- Audience relevance: 15.
- Analysis potential: 10.
- Search shelf life: 10.
- Original-angle opportunity: 5.

Penalties are visible negative values:

- Rumor risk: up to -20.
- Recent coverage: up to -25.
- Weak evidence: up to -20.
- Saturation: up to -10.
- Staleness: configurable, default up to -10.
- Single-source dependency: configurable, default -8.

Scores are clamped to 0-100. Each component is a separate function or bounded heuristic. The current time is injected, allowing exact fixture tests.

Freshness uses newest-signal age, primary-source presence, and publication spread. Missing dates are treated conservatively. Audience relevance matches weighted categories, keywords, and entities rather than brand names alone.

## Evidence, rumor risk, and shelf life

Evidence labels are `strong`, `moderate`, `weak`, or `insufficient`. They use primary-source presence, unique independent publishers, authority mix, publication timestamps, and rumor language. Strong community activity can raise discussion score but cannot create evidence strength.

Rumor phrases only flag uncertainty and add penalties; forward-looking items are not automatically discarded.

Shelf-life labels are `hours`, `days`, `weeks`, `months`, or `evergreen`. The heuristic considers rumor status, release/update language, hardware lifecycle, and guide/reference potential.

## History and suppression

`HistoryRepository` abstracts topic history. `FileHistoryRepository` reads prior recommended, approved, rejected, and published records with configurable windows.

Recent exact fingerprints and substantial product/event overlap are suppressed with reasons. A later item containing configured terms such as `security`, `fixes`, or `patch` can receive a meaningful-update override when it follows prior coverage of the same product. Merely mentioning the same company is insufficient for suppression.

Fingerprints hash sorted entities, product identifiers, event keywords, date bucket, and primary URLs. They support history matching but are not the sole clustering feature.

## Configuration

`automation/config/ranking.example.yaml` validates:

- Clustering threshold, complete-link ratio, time windows, and keyword limit.
- Positive score weights and penalties.
- Eligibility, output, and packet limits.
- Suppression windows.
- Stop words, safe title rules, rumor patterns, event families, and update terms.
- Entity aliases, relevance weights, and publisher groups.

Positive weights must total 100, thresholds are bounded, and the packet cannot exceed the ranked candidate limit.

## CLI

Run discovery first, then rank its normalized output:

```bash
npm run pipeline:topics -- --run-id run_20260806_example
```

Run the deterministic sample directly:

```bash
npm run pipeline:topics -- \
  --run-id run_20260806_ranking_fixture \
  --input data/samples/ranking-normalized-items.json \
  --history data/samples/ranking-history.json \
  --config automation/config/ranking.example.yaml \
  --now 2026-08-06T20:00:00.000Z
```

Aliases are available as `npm run cluster`, `npm run rank`, and `npm run editorial-packet`. Milestone 2 treats clustering and ranking as one cohesive idempotent artifact set, so each alias validates or materializes the complete set and reports the requested stage label.

Use `--help` for accepted arguments. A missing run ID, invalid timestamp, configuration error, missing normalized input, or corrupt completed artifact causes a nonzero exit.

## Output files

```text
data/runs/<runId>/story-clusters.json
data/runs/<runId>/topic-candidates.json
data/runs/<runId>/ranked-topics.json
data/runs/<runId>/suppressed-topics.json
data/runs/<runId>/ranking-report.json
data/runs/<runId>/ai-ranking-packet.json
```

Completed artifact sets are validated and reused byte-for-byte. Use a new run ID to recompute with different input, configuration, history, or time.

The AI ranking packet is preparation only. It contains at most 20 compact candidate records and no raw feeds or full source text. Nothing sends the packet to Claude, Gemini, or another model.

## Test strategy

Offline tests cover title edge cases, keyword weighting, entity false positives, similarity explanations, distinct product/version events, time distance, complete-link safeguards, representative titles, all scoring components, rumor/evidence penalties, discussion signals, history suppression, meaningful updates, atomic output, reuse, and complete integration with ten sample source items.

## Known limitations

- Entity hints depend on configured aliases and a small product/version pattern set.
- Rules are English-first.
- Conservative complete-link clustering may split coverage with unusually different wording.
- File history is appropriate for the current single-operator workflow, not concurrent multi-writer use.
- Shelf life and original-angle scores are transparent heuristics, not editorial judgment.
- Ranking uses normalized discovery items; exact duplicates removed by Milestone 1 are not restored.

## Deferred to Milestone 3

Telegram cards, callbacks, approval persistence, custom topic commands, and workflow dispatch are not implemented. `pending` candidates still require the separate Telegram topic approval gate, and publication remains protected by the later final article approval gate.
