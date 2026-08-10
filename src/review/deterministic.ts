import type { ResearchPacket } from "../research/models";
import { articleStructures } from "../writing/article-type";
import { inspectMdx } from "../writing/mdx";
import type { ArticleDraft, DraftQualityReport } from "../writing/models";
import { sha256 } from "../writing/task";
import type { ReviewConfig } from "./config";
import {
  deterministicEditorialReportSchema,
  editorialIssueSchema,
  editorialRiskSummarySchema,
  type EditorialIssue,
  type EditorialIssueCategory,
  type EditorialIssueSeverity,
  type EditorialRiskSummary,
} from "./models";

export function runDeterministicEditorialReview(
  draft: ArticleDraft,
  quality: DraftQualityReport,
  packet: ResearchPacket,
  config: ReviewConfig,
  now: string,
) {
  const issues: EditorialIssue[] = [];
  const checks: { code: string; passed: boolean; explanation: string }[] = [];
  const headings = inspectMdx(
    draft.mdx,
    new Set(packet.sourceIndex.map((x) => x.id)),
  ).headings;
  const add = (
    code: string,
    category: EditorialIssueCategory,
    severity: EditorialIssueSeverity,
    title: string,
    description: string,
    blocking = false,
    details: Partial<EditorialIssue> = {},
  ) => {
    const issue = editorialIssueSchema.parse({
      id: `issue_${sha256(`${draft.id}:${draft.version}:${code}:${details.section ?? ""}`).slice(0, 24)}`,
      category,
      severity,
      status: "open",
      title,
      description,
      claimReferenceIds: [],
      sourceIds: [],
      blocking,
      createdAt: now,
      ...details,
    });
    if (!issues.some((x) => x.id === issue.id)) issues.push(issue);
    checks.push({ code, passed: false, explanation: description });
  };
  const pass = (code: string, explanation: string) =>
    checks.push({ code, passed: true, explanation });
  if (quality.status === "blocked" || quality.blockingIssues.length)
    add(
      "m5_quality",
      "mdx",
      "critical",
      "Milestone 5 quality is blocked",
      "The selected draft failed its required writing-stage validation.",
      true,
    );
  else pass("m5_quality", "Milestone 5 quality passed");
  if (quality.citationCoverage.score < config.minimumCitationCoverage)
    add(
      "citation_threshold",
      "citation",
      "major",
      "Citation coverage is below threshold",
      `Coverage ${quality.citationCoverage.score} is below ${config.minimumCitationCoverage}.`,
      true,
    );
  else
    pass(
      "citation_threshold",
      "Citation coverage meets the configured threshold",
    );
  const titleTokens = tokens(draft.title);
  const bodyTokens = tokens(draft.plainText);
  const titleTokenList = [...titleTokens];
  const titleOverlap =
    titleTokenList.filter((x) => bodyTokens.has(x)).length /
    Math.max(1, titleTokenList.length);
  if (titleOverlap < 0.45)
    add(
      "headline_scope",
      "headline_accuracy",
      "major",
      "Headline may not match article scope",
      "Fewer than 45% of meaningful headline terms appear in the article.",
      true,
    );
  else pass("headline_scope", "Headline terms align with the draft");
  if (
    /!{2,}|you won.t believe|shocking|game[- ]changer|everything you need to know/i.test(
      draft.title,
    )
  )
    add(
      "headline_clickbait",
      "headline_accuracy",
      "major",
      "Headline uses clickbait language",
      "The headline contains fake urgency, inflated framing, or excessive punctuation.",
      true,
    );
  if (
    /(?:I|we) (?:tested|used|reviewed|benchmarked)|(?:my|our) hands-on|in (?:my|our) testing/i.test(
      draft.mdx,
    )
  )
    add(
      "first_hand",
      "first_hand_claim",
      "critical",
      "Unapproved first-hand claim",
      "The article implies hands-on testing without approved evidence.",
      true,
    );
  if (
    ["source_based_review", "buying_analysis"].includes(draft.articleType) &&
    !/(?:based on|drawn from) (?:published|available|supplied) (?:sources|evidence)|not (?:a )?hands-on/i.test(
      draft.mdx,
    )
  )
    add(
      "product_disclosure",
      "product_disclosure",
      "critical",
      "Mandatory source-based disclosure is missing",
      "Product analysis must state that it is based on published evidence and is not hands-on.",
      true,
    );
  const firstParagraph = draft.plainText.split(/\n\s*\n/)[0] ?? "";
  if (
    firstParagraph.split(/\s+/).length < 15 ||
    /in today.s|fast-paced|ever-evolving/i.test(firstParagraph)
  )
    add(
      "introduction",
      "structure",
      "major",
      "Introduction does not establish the event or reader problem",
      "The opening is too short or generic to establish the practical question.",
    );
  else pass("introduction", "Introduction establishes usable context");
  const lastHeading = headings.at(-1)?.text ?? "";
  if (
    !/conclusion|takeaway|outlook|recommendation|what to watch|bottom line/i.test(
      lastHeading,
    )
  )
    add(
      "conclusion",
      "structure",
      "warning",
      "Conclusion is not clearly identifiable",
      "The final section may not answer the article's practical question.",
    );
  else pass("conclusion", "A practical concluding section is present");
  if (
    packet.counterpoints.length &&
    !/counterpoint|limitation|however|although|tradeoff|caveat/i.test(draft.mdx)
  )
    add(
      "counterpoints",
      "missing_uncertainty",
      "major",
      "Material counterpoints may be missing",
      "The research packet includes counterpoints but the draft does not clearly signal them.",
      true,
    );
  if (
    (packet.unknowns.length || packet.conflicts.length) &&
    !/unknown|uncertain|conflict|limitation|not clear|remains/i.test(draft.mdx)
  )
    add(
      "uncertainty",
      "missing_uncertainty",
      packet.conflicts.some((x) => x.severity === "blocking")
        ? "critical"
        : "major",
      "Research uncertainty is not preserved",
      "The draft does not clearly retain packet unknowns or conflicts.",
      true,
    );
  if (packet.conflicts.some((x) => x.severity === "blocking" && !x.resolution))
    add(
      "critical_conflict",
      "conflicting_evidence",
      "critical",
      "Critical research conflict remains unresolved",
      "A blocking packet conflict has no recorded resolution.",
      true,
    );
  const sourceMap = new Map(packet.sourceIndex.map((x) => [x.id, x]));
  const claimMap = new Map(
    [
      ...packet.facts,
      ...packet.interpretations,
      ...packet.predictions,
      ...packet.communityObservations,
    ].map((x) => [x.id, x]),
  );
  for (const reference of draft.claimReferences) {
    for (const claimId of reference.researchClaimIds) {
      const claim = claimMap.get(claimId);
      if (!claim) {
        add(
          `unknown_claim_${claimId}`,
          "factual_support",
          "critical",
          "Unknown mapped research claim",
          "A draft claim maps to an unavailable research claim.",
          true,
          { claimReferenceIds: [reference.id], sourceIds: reference.sourceIds },
        );
        continue;
      }
      if (
        claim.status === "conflicting" ||
        claim.status === "unsupported" ||
        claim.status === "unverified"
      )
        add(
          `weak_claim_${claimId}`,
          "conflicting_evidence",
          claim.status === "conflicting" ? "critical" : "major",
          "Mapped claim is not fully supported",
          `Research claim status is ${claim.status}.`,
          true,
          { claimReferenceIds: [reference.id], sourceIds: reference.sourceIds },
        );
      const primary = claim.sourceIds.filter(
        (id) => sourceMap.get(id)?.isPrimary,
      );
      if (
        primary.length &&
        !reference.sourceIds.some((id) => primary.includes(id))
      )
        add(
          `primary_${claimId}`,
          "source_misrepresentation",
          "major",
          "Primary-source fact cites only secondary evidence",
          "A primary source exists for this claim but is absent from the draft mapping.",
          true,
          { claimReferenceIds: [reference.id], sourceIds: reference.sourceIds },
        );
    }
    if (
      reference.claimType === "prediction" &&
      reference.supportStatus !== "prediction"
    )
      add(
        `prediction_${reference.id}`,
        "factual_support",
        "major",
        "Prediction is not labeled",
        "A prediction claim must retain prediction support status.",
        true,
        { claimReferenceIds: [reference.id], sourceIds: reference.sourceIds },
      );
    if (
      reference.claimType === "opinion" &&
      reference.supportStatus !== "opinion"
    )
      add(
        `opinion_${reference.id}`,
        "factual_support",
        "major",
        "Opinion may be presented as fact",
        "An opinion claim must retain opinion support status.",
        true,
        { claimReferenceIds: [reference.id] },
      );
    if (
      /\b(?:proves?|guarantees?|always|never|undeniably|certainly)\b/i.test(
        reference.statement,
      )
    )
      add(
        `certainty_${reference.id}`,
        "factual_support",
        "major",
        "Unsupported certainty language",
        "A mapped claim uses certainty that deterministic evidence cannot establish.",
        true,
        { claimReferenceIds: [reference.id], sourceIds: reference.sourceIds },
      );
  }
  if (
    /\b(?:today|currently|right now|this week)\b/i.test(draft.mdx) &&
    !/\b(?:20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      draft.mdx,
    )
  )
    add(
      "timeliness",
      "missing_uncertainty",
      "warning",
      "Time-sensitive language lacks durable context",
      "Relative time language should include an exact date when it affects meaning.",
    );
  if (
    /\b(?:\$|USD|EUR|GBP)\s?\d|\bavailable\b/i.test(draft.mdx) &&
    !/\b(?:20\d{2}|U\.S\.|US|United States|region|market|as of)\b/i.test(
      draft.mdx,
    )
  )
    add(
      "price_availability",
      "factual_support",
      "warning",
      "Price or availability may lack date or region caveat",
      "Time- or region-sensitive buying information needs durable context.",
    );
  const quotes = [...draft.mdx.matchAll(/^>\s+(.+)$/gm)];
  for (const [index, quote] of quotes.entries()) {
    const count = words(quote[1] ?? "");
    if (count > config.maximumQuoteWords)
      add(
        `quote_${index}`,
        "copyright",
        count > config.maximumQuoteWords * 2 ? "critical" : "major",
        "Quotation exceeds configured limit",
        `Block quotation contains ${count} words; limit is ${config.maximumQuoteWords}.`,
        count > config.maximumQuoteWords * 2,
      );
  }
  const excerpts = packet.sourceIndex.flatMap((source) =>
    source.selectedExcerpts.map((excerpt) => ({
      sourceId: source.id,
      text: excerpt.text,
    })),
  );
  for (const excerpt of excerpts) {
    const phrase = normalize(excerpt.text);
    if (phrase.length > 60 && normalize(draft.plainText).includes(phrase))
      add(
        `copy_${excerpt.sourceId}_${sha256(phrase).slice(0, 6)}`,
        "copyright",
        "major",
        "Draft repeats a stored source excerpt",
        "A long source excerpt appears verbatim in the draft and should be paraphrased or shortened.",
        true,
        { sourceIds: [excerpt.sourceId] },
      );
  }
  const headingLevels = headings.map((x) => x.level);
  if (
    headingLevels.some(
      (level, index) =>
        index > 0 && level - (headingLevels[index - 1] ?? level) > 1,
    )
  )
    add(
      "heading_hierarchy",
      "structure",
      "warning",
      "Heading hierarchy skips a level",
      "Headings should follow a logical hierarchy.",
    );
  const normalizedHeadings = headings.map((x) => normalize(x.text));
  if (new Set(normalizedHeadings).size !== normalizedHeadings.length)
    add(
      "repeated_sections",
      "repetition",
      "warning",
      "Repeated section heading",
      "Two or more sections use the same normalized heading.",
    );
  const expected = articleStructures[draft.articleType];
  const outline = normalizedHeadings.join(" ");
  const represented = expected.filter((section) =>
    [...tokens(section)].some((token) => outline.includes(token)),
  ).length;
  if (represented / expected.length < 0.4)
    add(
      "article_type_structure",
      "structure",
      "major",
      "Article type does not match actual structure",
      `Only ${represented} of ${expected.length} recommended structural elements are visible.`,
      true,
    );
  if (
    draft.description.toLowerCase() === draft.title.toLowerCase() ||
    /best|ultimate|perfect|guaranteed|must-have/i.test(draft.description)
  )
    add(
      "metadata_overstatement",
      "seo",
      "major",
      "Description overstates or repeats the headline",
      "SEO metadata should summarize accurately without inflated claims.",
      true,
    );
  if (/best|ultimate|perfect|stunning|beautiful|must-have/i.test(draft.heroAlt))
    add(
      "alt_promotional",
      "accessibility",
      "warning",
      "Hero alt text is promotional",
      "Alt text should describe meaning rather than market the article.",
    );
  else pass("alt_text", "Hero alt text is descriptive");
  const riskSummary = classifyEditorialRisk(issues);
  const blockingIssueCount = issues.filter(
    (x) => x.blocking && ["major", "critical"].includes(x.severity),
  ).length;
  const warningCount = issues.filter(
    (x) => ["info", "warning"].includes(x.severity) || !x.blocking,
  ).length;
  return deterministicEditorialReportSchema.parse({
    id: `detreview_${sha256(`${draft.id}:${draft.version}:${quality.createdAt}`).slice(0, 24)}`,
    topicId: draft.topicId,
    draftId: draft.id,
    draftVersion: draft.version,
    qualityReportHash: sha256(JSON.stringify(quality)),
    status: issues.some(
      (x) =>
        x.severity === "critical" || (x.blocking && x.severity === "major"),
    )
      ? "blocked"
      : issues.length
        ? "eligible_with_warnings"
        : "eligible",
    issues,
    riskSummary,
    citationCoverageScore: quality.citationCoverage.score,
    blockingIssueCount,
    warningCount,
    checks,
    createdAt: now,
  });
}

export function classifyEditorialRisk(
  issues: EditorialIssue[],
): EditorialRiskSummary {
  const by = (categories: EditorialIssueCategory[]) =>
    maximum(
      issues
        .filter((x) => categories.includes(x.category))
        .map((x) => severityRisk(x.severity)),
    );
  const values = {
    factual: by([
      "factual_support",
      "missing_uncertainty",
      "conflicting_evidence",
      "citation",
    ]),
    source: by(["source_misrepresentation", "citation"]),
    legalReputational: by(["legal_risk", "first_hand_claim"]),
    copyright: by(["copyright"]),
    productDisclosure: by(["product_disclosure", "first_hand_claim"]),
    timeliness: by(["missing_uncertainty"]),
    brandConsistency: by(["brand_voice", "ai_style", "headline_accuracy"]),
    technicalAccuracy: by(["factual_support", "conflicting_evidence"]),
    publicationReadiness: maximum(issues.map((x) => severityRisk(x.severity))),
  };
  const overall = maximum(Object.values(values));
  return editorialRiskSummarySchema.parse({
    ...values,
    overall,
    explanations: issues
      .filter((x) => ["major", "critical"].includes(x.severity))
      .map((x) => `${x.severity}: ${x.title}`),
  });
}
function severityRisk(
  value: EditorialIssueSeverity,
): "low" | "moderate" | "high" | "critical" {
  return (
    {
      info: "low",
      warning: "moderate",
      major: "high",
      critical: "critical",
    } as const
  )[value];
}
function maximum(values: string[]): "low" | "moderate" | "high" | "critical" {
  const order = ["low", "moderate", "high", "critical"] as const;
  return (
    order[
      Math.max(
        0,
        ...values.map((x) => order.indexOf(x as (typeof order)[number])),
      )
    ] ?? "low"
  );
}
function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function tokens(value: string) {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((x) => x.length > 3),
  );
}
function words(value: string) {
  return value.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}
