export function estimateContribution({
  priceCents,
  minutes,
  participants = 2,
  hostShareBasisPoints = 7000,
  processorBasisPoints = 0,
  processorFixedCents = 0,
  mediaMicrosPerParticipantMinute = 0,
  supportCents = 0,
  expectedRefundAndCreditLossCents = 0,
  allocatedAcquisitionCents = 0,
} = {}) {
  for (const [label, value, min, max] of [
    ["priceCents", priceCents, 0, 100000000],
    ["minutes", minutes, 1, 480],
    ["participants", participants, 2, 3],
    ["hostShareBasisPoints", hostShareBasisPoints, 0, 10000],
    ["processorBasisPoints", processorBasisPoints, 0, 10000],
    ["processorFixedCents", processorFixedCents, 0, 100000000],
    ["mediaMicrosPerParticipantMinute", mediaMicrosPerParticipantMinute, 0, 100000000],
    ["supportCents", supportCents, 0, 100000000],
    ["expectedRefundAndCreditLossCents", expectedRefundAndCreditLossCents, 0, 100000000],
    ["allocatedAcquisitionCents", allocatedAcquisitionCents, 0, 100000000],
  ]) {
    if (!Number.isInteger(value) || value < min || value > max)
      throw new RangeError(label + " must be an integer from " + min + " to " + max);
  }
  const hostCents = Math.round((priceCents * hostShareBasisPoints) / 10000);
  const processorCents =
    Math.round((priceCents * processorBasisPoints) / 10000) + processorFixedCents;
  const participantMinutes = minutes * participants;
  const mediaCents = Math.round(
    (mediaMicrosPerParticipantMinute * participantMinutes) / 10000,
  );
  const contributionBeforeAcquisitionCents =
    priceCents - hostCents - processorCents - mediaCents - supportCents -
    expectedRefundAndCreditLossCents;
  return {
    priceCents,
    participantMinutes,
    hostCents,
    processorCents,
    mediaCents,
    supportCents,
    expectedRefundAndCreditLossCents,
    allocatedAcquisitionCents,
    contributionBeforeAcquisitionCents,
    contributionCents: contributionBeforeAcquisitionCents - allocatedAcquisitionCents,
  };
}
