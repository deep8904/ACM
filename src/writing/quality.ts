import type { ResearchPacket } from "../research/models";
import type { WritingConfig } from "./config";
import { articleStructures } from "./article-type";
import { inspectMdx } from "./mdx";
import type {
  ArticleWritingResult,
  DraftClaimReference,
  DraftQualityReport,
} from "./models";

export function evaluateDraft(
  result: ArticleWritingResult,
  packet: ResearchPacket,
  references: DraftClaimReference[],
  config: WritingConfig,
  draftId: string,
  draftVersion: number,
  now: string,
): DraftQualityReport {
  const knownSources = new Set(packet.sourceIndex.map((x) => x.id));
  const knownClaims = new Map(
    [
      ...packet.facts,
      ...packet.interpretations,
      ...packet.predictions,
      ...packet.communityObservations,
    ].map((x) => [x.id, x]),
  );
  const mdx = inspectMdx(result.mdx, knownSources);
  const blockingIssues = [
    ...mdx.safetyIssues,
    ...mdx.unknownCitationSourceIds.map((x) => `Unknown citation source: ${x}`),
  ];
  blockingIssues.push(
    ...result.sourceIdsUsed
      .filter((id) => !knownSources.has(id))
      .map((id) => `Unknown declared source: ${id}`),
  );
  blockingIssues.push(
    ...mdx.citationSourceIds
      .filter((id) => !result.sourceIdsUsed.includes(id))
      .map((id) => `Citation source was not declared in sourceIdsUsed: ${id}`),
  );
  const claimSupport: string[] = [];
  let unsupportedClaims = 0;
  for (const reference of references) {
    if (
      !mdx.headings.some(
        (heading) =>
          heading.text.toLocaleLowerCase() ===
          reference.section.toLocaleLowerCase(),
      )
    )
      claimSupport.push(
        `${reference.id} names a section that is not present in the MDX outline`,
      );
    const missingClaims = reference.researchClaimIds.filter(
      (id) => !knownClaims.has(id),
    );
    const missingSources = reference.sourceIds.filter(
      (id) => !knownSources.has(id),
    );
    if (missingClaims.length)
      blockingIssues.push(
        `Unknown research claim(s) in ${reference.id}: ${missingClaims.join(", ")}`,
      );
    if (missingSources.length)
      blockingIssues.push(
        `Unknown source(s) in ${reference.id}: ${missingSources.join(", ")}`,
      );
    if (reference.supportStatus === "unsupported") unsupportedClaims += 1;
    for (const id of reference.researchClaimIds) {
      const claim = knownClaims.get(id);
      if (
        claim &&
        !reference.sourceIds.every((sourceId) =>
          claim.sourceIds.includes(sourceId),
        )
      )
        claimSupport.push(
          `${reference.id} cites a source that does not support research claim ${id}`,
        );
      if (
        claim &&
        claim.claimType !== reference.claimType &&
        !(
          ["fact", "specification", "timeline", "quote"].includes(
            claim.claimType,
          ) && reference.claimType === "fact"
        )
      )
        claimSupport.push(
          `${reference.id} claim type ${reference.claimType} is incompatible with research claim ${id} type ${claim.claimType}`,
        );
    }
  }
  if (unsupportedClaims > config.unsupportedClaimLimit)
    blockingIssues.push(
      `Unsupported claim count ${unsupportedClaims} exceeds configured limit ${config.unsupportedClaimLimit}`,
    );
  blockingIssues.push(...claimSupport);
  if (
    /\b(?:I|we) (?:tested|used|reviewed|benchmarked)|\b(?:my|our) hands-on\b|\bin (?:my|our) testing\b/i.test(
      result.mdx,
    )
  )
    blockingIssues.push("Unapproved first-hand experience or testing claim");
  const disclosureChecks: string[] = [];
  if (["source_based_review", "buying_analysis"].includes(result.articleType)) {
    if (
      !/(?:based on|drawn from) (?:published|available|supplied) (?:sources|evidence)|not (?:a )?hands-on/i.test(
        result.mdx,
      )
    )
      blockingIssues.push("Required source-based review disclosure is missing");
    else disclosureChecks.push("Source-based disclosure present");
  }
  const words = mdx.plainText.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const wordCount = words.length;
  const readingTime = Math.max(
    1,
    Math.ceil(wordCount / config.readingWordsPerMinute),
  );
  const range = config.wordRanges[result.articleType];
  const warnings: string[] = [];
  if (wordCount < range.min || wordCount > range.max)
    warnings.push(
      `Word count ${wordCount} is outside ${range.min}-${range.max}`,
    );
  const headingChecks: string[] = [];
  if (!mdx.headings.some((x) => x.level === 2))
    blockingIssues.push("At least one H2 heading is required");
  else headingChecks.push("H2 heading present");
  if (mdx.headings.some((x) => x.level > 4))
    warnings.push("Heading depth exceeds H4");
  const firstH2 = result.mdx.search(/^##\s/m);
  if (firstH2 < 80)
    warnings.push("Introduction before the first H2 is too short");
  if (
    !mdx.headings.some((x) =>
      /conclusion|takeaway|bottom line|what to watch|recommendation|outlook/i.test(
        x.text,
      ),
    )
  )
    warnings.push("No recognizable conclusion or takeaway heading");
  const normalizedHeadings = mdx.headings
    .map((x) => x.text.toLowerCase())
    .join(" ");
  const absentStructure = articleStructures[result.articleType].filter(
    (section) =>
      !section
        .toLowerCase()
        .split(/\W+/)
        .some((word) => word.length > 4 && normalizedHeadings.includes(word)),
  );
  if (absentStructure.length)
    headingChecks.push(
      `Recommended structure not clearly represented: ${absentStructure.join(", ")}`,
    );
  const forbiddenLanguage = [
    ...config.forbiddenPhrases,
    ...config.aiCliches,
  ].filter((phrase) => result.mdx.toLowerCase().includes(phrase.toLowerCase()));
  if (forbiddenLanguage.length)
    warnings.push(
      `Forbidden or clichéd language detected: ${forbiddenLanguage.join(", ")}`,
    );
  const paragraphs = mdx.plainText
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const counts = new Map<string, number>();
  for (const paragraph of paragraphs)
    counts.set(
      paragraph.toLowerCase(),
      (counts.get(paragraph.toLowerCase()) ?? 0) + 1,
    );
  const repetition = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([text]) => `Repeated paragraph: ${text.slice(0, 120)}`);
  const sentences = mdx.plainText
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 30);
  const sentenceCounts = new Map<string, number>();
  for (const sentence of sentences)
    sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
  repetition.push(
    ...[...sentenceCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([text]) => `Repeated sentence: ${text.slice(0, 120)}`),
  );
  for (const paragraph of paragraphs) {
    const length = paragraph.split(/\s+/).length;
    if (length > 180)
      warnings.push(`Paragraph exceeds 180 words: ${paragraph.slice(0, 80)}`);
    if (length < 3)
      warnings.push(`Very short paragraph: ${paragraph.slice(0, 80)}`);
  }
  const exclamations = (result.mdx.match(/!/g) ?? []).length;
  const emDashes = (result.mdx.match(/—/g) ?? []).length;
  const questions = (result.mdx.match(/\?/g) ?? []).length;
  if (exclamations > 3)
    warnings.push(`Excessive exclamation points: ${exclamations}`);
  if (emDashes > 5) warnings.push(`Excessive em dashes: ${emDashes}`);
  if (questions > 5)
    warnings.push(`Excessive rhetorical questions: ${questions}`);
  if (
    /^(?:in this article|today we(?:'ll| will)|this piece)/i.test(mdx.plainText)
  )
    warnings.push("Generic introduction language detected");
  if (
    /^(?:in conclusion|to sum up|at the end of the day)/i.test(
      paragraphs.at(-1) ?? "",
    )
  )
    warnings.push("Generic conclusion language detected");
  for (const link of mdx.links) {
    if (/^https?:/i.test(link)) {
      try {
        const url = new URL(link);
        if (
          [...url.searchParams.keys()].some((key) =>
            /^(?:utm_|fbclid|gclid)/i.test(key),
          )
        )
          warnings.push(`Tracking parameters in external link: ${link}`);
      } catch {
        blockingIssues.push(`Invalid external link: ${link}`);
      }
    }
  }
  for (const quote of result.mdx.matchAll(/^>\s+(.+)$/gm))
    if ((quote[1]?.split(/\s+/).length ?? 0) > 50)
      warnings.push("Long quotation may exceed fair-use excerpt guidance");
  const title = result.metadata.title;
  if ((title.match(/:/g) ?? []).length > 1)
    warnings.push("Title contains multiple colons");
  if (
    /\b(?:you won't believe|shocking|game[- ]changer|must see)\b|!{2,}/i.test(
      title,
    )
  )
    blockingIssues.push("Clickbait title pattern detected");
  const critical = references.filter((x) =>
    ["fact", "specification", "timeline", "quote"].includes(x.claimType),
  );
  const covered = critical.filter(
    (x) =>
      x.supportStatus === "supported" &&
      x.sourceIds.some((id) => mdx.citationSourceIds.includes(id)),
  );
  const weightedTotal = references.reduce((n, x) => n + weight(x.claimType), 0);
  const weightedCovered = references.reduce(
    (n, x) =>
      n +
      (x.supportStatus === "supported" &&
      x.sourceIds.some((id) => mdx.citationSourceIds.includes(id))
        ? weight(x.claimType)
        : 0),
    0,
  );
  const score = weightedTotal
    ? Math.round((weightedCovered / weightedTotal) * 100)
    : 100;
  if (covered.length < critical.length)
    blockingIssues.push(
      "One or more critical claims lack a matching inline citation",
    );
  const uniqueBlocking = [...new Set(blockingIssues)];
  return {
    draftId,
    draftVersion,
    status: uniqueBlocking.length
      ? "blocked"
      : warnings.length
        ? "passed_with_warnings"
        : "passed",
    wordCount,
    readingTime,
    headingChecks,
    frontmatterChecks: ["Frontmatter will be generated by the importer"],
    mdxSafetyChecks: mdx.safetyIssues.length
      ? []
      : ["MDX safety checks passed"],
    citationCoverage: {
      coveredCriticalClaims: covered.map((x) => x.id),
      uncoveredCriticalClaims: critical
        .filter((x) => !covered.includes(x))
        .map((x) => x.id),
      unknownCitationMarkers: mdx.unknownCitationSourceIds,
      citationDensity: wordCount
        ? Number(((mdx.citationSourceIds.length / wordCount) * 1000).toFixed(2))
        : 0,
      citationQualityWarnings: claimSupport,
      score,
    },
    claimSupport,
    forbiddenLanguage,
    repetition,
    linkChecks: mdx.links,
    disclosureChecks,
    blockingIssues: uniqueBlocking,
    warnings: [...warnings, ...repetition],
    createdAt: now,
  };
}
function weight(type: DraftClaimReference["claimType"]) {
  return ["fact", "specification", "timeline", "quote"].includes(type)
    ? 3
    : ["interpretation", "community_observation"].includes(type)
      ? 1
      : 0;
}
