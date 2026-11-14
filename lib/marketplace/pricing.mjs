import { experiences, stylesFor } from "../catalog.mjs";

export const BETA_PRICE_POLICY = Object.freeze({
  version: "beta-usd-2026-11-14",
  currency: "USD",
  prices: Object.freeze({ 15: 1000, 30: 1800 }),
  hostShareBasisPoints: 7000,
  quoteTtlMs: 180_000,
});
export function quoteFor(input, policy = BETA_PRICE_POLICY) {
  const {
    experience,
    duration,
    format,
    language,
    style = null,
    now = Date.now(),
  } = input;
  if (
    !experiences.some((item) => item.id === experience) ||
    ![15, 30].includes(duration) ||
    !["audio", "video"].includes(format) ||
    !["English", "Spanish"].includes(language) ||
    (style && !stylesFor(experience).some((item) => item.id === style))
  )
    throw new Error(
      "Choose a supported experience, style, time, format and language.",
    );
  const baseCents = policy.prices[duration];
  if (
    policy.currency !== "USD" ||
    typeof policy.version !== "string" ||
    !Number.isSafeInteger(baseCents) ||
    baseCents <= 0 ||
    baseCents > 100_000 ||
    !Number.isInteger(policy.hostShareBasisPoints) ||
    policy.hostShareBasisPoints < 0 ||
    policy.hostShareBasisPoints > 10_000 ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(policy.quoteTtlMs) ||
    policy.quoteTtlMs <= 0 ||
    policy.quoteTtlMs > 180_000
  )
    throw new Error("The server price policy is unavailable.");
  return Object.freeze({
    id: crypto.randomUUID(),
    experience,
    style,
    duration,
    format,
    language,
    currency: policy.currency,
    baseCents,
    discountCents: 0,
    taxCents: 0,
    taxStatus: "not-configured",
    totalCents: baseCents,
    version: policy.version,
    hostShareBasisPoints: policy.hostShareBasisPoints,
    expiresAt: now + policy.quoteTtlMs,
  });
}
export function allocationFor(
  totalCents,
  basisPoints = BETA_PRICE_POLICY.hostShareBasisPoints,
) {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10_000
  )
    throw new Error("Invalid integer allocation.");
  const hostCents = Number(
    (BigInt(totalCents) * BigInt(basisPoints) + 5000n) / 10_000n,
  );
  return { hostCents, platformCents: totalCents - hostCents };
}
