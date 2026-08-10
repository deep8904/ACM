import type { ResearchPacket } from "../research/models";
import type { WritingConfig } from "./config";
import { articleTypeSchema, type ArticleType } from "./models";

const recommendationMap: Record<
  ResearchPacket["recommendedArticleType"],
  ArticleType
> = {
  news_analysis: "news_analysis",
  explainer: "technical_explainer",
  comparison: "comparison",
  technical_deep_dive: "technical_explainer",
  opinion: "opinion_analysis",
  unknown: "news_analysis",
};
export function selectArticleType(
  packet: ResearchPacket,
  requested: string | undefined,
  config: WritingConfig,
  now: Date,
): ArticleType {
  const type = requested
    ? articleTypeSchema.parse(requested)
    : recommendationMap[packet.recommendedArticleType];
  const errors: string[] = [];
  const independentTesting = packet.sourceIndex.some(
    (source) =>
      source.authority === "independent" &&
      ["technical_reporting", "research_paper"].includes(source.sourceType),
  );
  if (
    type === "source_based_review" &&
    (!packet.productSpecifications.length || !independentTesting)
  )
    errors.push(
      "source_based_review requires product specifications and independent testing evidence",
    );
  if (type === "tutorial_candidate" && packet.technicalDetails.length === 0)
    errors.push("tutorial_candidate requires actionable technical material");
  const newest = Math.max(
    0,
    ...packet.timeline.map((event) => Date.parse(event.occurredAt)),
  );
  if (
    type === "breaking_news" &&
    (!newest ||
      now.getTime() - newest > config.breakingNewsMaxAgeHours * 3_600_000)
  )
    errors.push(
      `breaking_news requires evidence newer than ${config.breakingNewsMaxAgeHours} hours`,
    );
  if (type === "comparison" && packet.productSpecifications.length < 2)
    errors.push(
      "comparison requires evidence for at least two products or versions",
    );
  if (errors.length)
    throw new Error(`Article type is incompatible: ${errors.join("; ")}`);
  return type;
}
export const articleStructures: Record<ArticleType, string[]> = {
  breaking_news: [
    "Confirmed event",
    "Key facts",
    "Immediate implications",
    "Limitations",
    "What to watch next",
  ],
  news_analysis: [
    "Event",
    "Context",
    "Meaning",
    "Impact by audience",
    "Counterpoints",
    "Outlook",
  ],
  technical_explainer: [
    "Problem or concept",
    "Background",
    "Mechanism",
    "Example",
    "Practical impact",
    "Limitations",
    "Takeaway",
  ],
  release_guide: [
    "What changed",
    "Important features",
    "Breaking changes",
    "Migration considerations",
    "Compatibility",
    "Who should update",
    "Known issues",
  ],
  source_based_review: [
    "Source-based disclosure",
    "Intended user",
    "Specifications",
    "Independent evidence",
    "Strengths",
    "Weaknesses",
    "Common complaints",
    "Alternatives",
    "Recommendation",
  ],
  buying_analysis: [
    "Source-based disclosure",
    "Reader needs",
    "Decision criteria",
    "Product evidence",
    "Tradeoffs",
    "Alternatives",
    "Who should buy",
    "Who should skip",
    "Pricing and availability caveats",
  ],
  comparison: [
    "Shared use case",
    "Fair criteria",
    "Evidence parity",
    "Side-by-side comparison",
    "Recommendation by user type",
  ],
  industry_analysis: [
    "Event",
    "Industry context",
    "Evidence",
    "Stakeholder impact",
    "Counterpoints",
    "Outlook",
  ],
  opinion_analysis: [
    "Factual foundation",
    "Explicit thesis",
    "Supporting reasoning",
    "Counterargument",
    "Limitations",
    "Conclusion",
  ],
  tutorial_candidate: [
    "Problem",
    "Prerequisites",
    "Mechanism",
    "Procedure",
    "Verification",
    "Limitations",
    "Takeaway",
  ],
};
