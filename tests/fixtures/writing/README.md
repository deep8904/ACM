# Writing fixtures

The executable offline fixture constructors are `packet()` and `result()` in `src/writing/__tests__/writing.test.ts`. They produce strict ready research packets and Claude Code result objects without network or model access. Per-test overrides cover insufficient and blocked eligibility, cancellation gates, stale breaking news, incompatible review/tutorial/comparison types, overlap, unknown source IDs, missing citations, unsafe MDX vectors, fake hands-on language, missing source-based disclosure, AI clichés, duplicate replay, and a modified valid import.

`examples/article-writing-result.example.json` is the human-readable valid result fixture. Existing Milestone 4 fixtures supply official, technical, community, conflict, JSON, and missing-date source material. Keeping the variants as parsed factory overrides prevents large copied source bodies or divergent fixture schemas.
