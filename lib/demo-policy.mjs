// This repository is a simulator. No flag in user input can enable a provider.
export const DEMO_RUNTIME = Object.freeze({
  mode: "demo",
  joinDeadlineMs: 3 * 60_000,
});
export const TERMINAL = Object.freeze([
  "COMPLETED",
  "PARTIAL_DELIVERY",
  "CANCELLED",
  "DECLINED",
  "EXPIRED",
  "FAILED_SERVICE",
]);
export const isTerminal = (status) => TERMINAL.includes(status);
export const priceFor = (duration) =>
  duration === 15 ? 1000 : duration === 30 ? 1800 : null;
export const DEMO_CAPABILITIES = Object.freeze({
  demo: true,
  livePaymentsEnabled: false,
  liveCallsEnabled: false,
  staffSafetyEnabled: false,
});
