import { hosts, experiences, stylesFor } from "./catalog.mjs";
import { isTerminal } from "./demo-policy.mjs";

export function hostAvailable(state, host) {
  return (
    !!state &&
    !state.closed &&
    state.hostOnline[host.id] === true &&
    !state.blocks.includes(host.id) &&
    !state.bookings.some((b) => b.hostId === host.id && !isTerminal(b.status))
  );
}

export function rankMatches(state, preferences) {
  if (!state || state.closed)
    return {
      matches: [],
      reason: "Start a fresh demo workspace to find a moment.",
    };
  if (!state.operations.staffed || !state.operations.providerHealthy)
    return {
      matches: [],
      reason:
        "Demo sessions are paused in Operations. Try again when the demo controls are on.",
    };
  if (state.bookings.some((b) => !isTerminal(b.status)))
    return {
      matches: [],
      reason:
        "You already have a moment in progress. Continue or cancel it before finding another.",
    };
  if (
    !experiences.some((e) => e.id === preferences.experience) ||
    !["audio", "video"].includes(preferences.format) ||
    ![15, 30].includes(preferences.duration) ||
    !["English", "Spanish"].includes(preferences.language) ||
    (preferences.style &&
      !stylesFor(preferences.experience).some(
        (s) => s.id === preferences.style,
      ))
  ) {
    return {
      matches: [],
      reason:
        "Choose an experience, a supported style, language, duration and format.",
    };
  }
  const matches = hosts
    .filter(
      (h) =>
        hostAvailable(state, h) &&
        h.experiences.includes(preferences.experience) &&
        h.formats.includes(preferences.format) &&
        h.languages.includes(preferences.language),
    )
    .map((h) => ({
      host: h,
      affinity:
        preferences.style && h.styles.includes(preferences.style) ? 1 : 0,
      assignments: state.matching?.counts?.[h.id] || 0,
      lastAssigned: state.matching?.lastAssigned?.[h.id] || 0,
    }))
    .sort(
      (a, b) =>
        b.affinity - a.affinity ||
        a.assignments - b.assignments ||
        a.lastAssigned - b.lastAssigned ||
        a.host.id.localeCompare(b.host.id),
    )
    .map((m) => ({
      ...m,
      reason: `${m.affinity ? "Enjoys your chosen style. " : ""}${m.host.languages.includes(preferences.language) ? preferences.language : ""} · ${preferences.format}. ${m.assignments === 0 ? "Has not been requested in this workspace yet." : "Rotated using requests in this workspace."}`,
    }));
  return {
    matches,
    reason: matches.length
      ? ""
      : "No fictional host fits those choices right now. Try another format or language, or explore other hosts. Nothing has been charged.",
  };
}
