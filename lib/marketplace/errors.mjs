export class MarketplaceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function requireCondition(condition, code, message, status = 409) {
  if (!condition) throw new MarketplaceError(code, message, status);
}
export function text(value, max = 2000) {
  requireCondition(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    "VALIDATION",
    "Provide a valid response.",
    400,
  );
  return value.trim();
}
