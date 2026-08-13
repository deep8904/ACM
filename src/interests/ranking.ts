import type { RankingConfig } from "../ranking/config";
import type { EditorialInterest } from "./models";

export function applyEditorialInterests(
  config: RankingConfig,
  interests: readonly EditorialInterest[],
): RankingConfig {
  const relevanceWeights = { ...config.relevanceWeights };
  for (const interest of interests) {
    if (interest.status !== "enabled") continue;
    for (const keyword of interest.keywords)
      relevanceWeights[keyword.toLowerCase()] = Math.max(
        relevanceWeights[keyword.toLowerCase()] ?? 0,
        4,
      );
  }
  return { ...config, relevanceWeights };
}
