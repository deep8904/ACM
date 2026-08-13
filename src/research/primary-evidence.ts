import type { ResearchPacket } from "./models";

type PrimaryEvidenceView = Pick<
  ResearchPacket,
  "primarySourceIds" | "sourceIndex"
>;

export function isMissingPrimaryReason(reason: string) {
  return (
    /^No primary source (?:was retrieved|was provided|could be retrieved)$/i.test(
      reason,
    ) || /^A primary source is required$/i.test(reason)
  );
}

export function hasVerifiedPrimaryEvidence(packet: PrimaryEvidenceView) {
  if (
    !Array.isArray(packet.primarySourceIds) ||
    !Array.isArray(packet.sourceIndex)
  )
    return false;
  const declared = new Set(packet.primarySourceIds);
  return packet.sourceIndex.some(
    (source) =>
      declared.has(source.id) &&
      source.isPrimary &&
      source.authority === "primary" &&
      source.extractionStatus === "extracted" &&
      source.selectedExcerpts.length > 0,
  );
}

export function resolvePrimaryBlockingReasons(
  packet: PrimaryEvidenceView,
  reasons: readonly string[],
) {
  return hasVerifiedPrimaryEvidence(packet)
    ? reasons.filter((reason) => !isMissingPrimaryReason(reason))
    : [...reasons];
}
