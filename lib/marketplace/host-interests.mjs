import { requireCondition } from "./errors.mjs";

export function normalizeHostInterests(value = []) {
  requireCondition(
    Array.isArray(value) &&
      value.length <= 8 &&
      value.every((interest) => typeof interest === "string" && interest.trim().length <= 40),
    "VALIDATION",
    "Add up to eight conversation topics, each 40 characters or fewer.",
    400,
  );
  return [...new Map(
    value.map((interest) => interest.trim()).filter(Boolean)
      .map((interest) => [interest.toLowerCase(), interest]),
  ).values()];
}
