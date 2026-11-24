import { stylesFor } from "./catalog.mjs";

export const styleRecommendationMessages = {
  liked: "You gave positive feedback after a session with this style.",
  previous: "You’ve chosen this style before.",
  starter: "A starting pick for this experience.",
  "no-fit": "Choose the style that feels right today.",
};

function feedback(booking) {
  if (booking.worthIt === false || (booking.rating >= 1 && booking.rating <= 2))
    return "negative";
  if (booking.worthIt === true || (booking.rating >= 4 && booking.rating <= 5))
    return "positive";
  return null;
}

// History is newest first. Callers supply structured choices and ratings only.
export function recommendStyle(experience, history = []) {
  const options = stylesFor(experience);
  const valid = new Set(options.map((option) => option.id));
  const recent = history
    .filter(
      (booking) =>
        booking.status === "COMPLETED" &&
        booking.experience === experience &&
        valid.has(booking.style),
    )
    .slice(0, 12);
  const candidates = options.map(({ id }) => {
    const visits = recent.filter((booking) => booking.style === id);
    return {
      style: id,
      feedback: visits.map(feedback).find(Boolean),
      count: visits.length,
      lastVisit: recent.findIndex((booking) => booking.style === id),
    };
  });
  const liked = candidates.filter((choice) => choice.feedback === "positive");
  // Prefer a different liked style if the latest session was also a good fit.
  const variety =
    liked.length > 1 ? liked.filter((choice) => choice.lastVisit !== 0) : liked;
  if (variety.length) {
    variety.sort((a, b) => b.count - a.count || a.lastVisit - b.lastVisit);
    return { style: variety[0].style, reason: "liked" };
  }
  const acceptable = candidates.filter((choice) => choice.feedback !== "negative");
  const familiar = acceptable.filter((choice) => choice.count > 0);
  if (familiar.length) {
    familiar.sort((a, b) => b.count - a.count || a.lastVisit - b.lastVisit);
    return { style: familiar[0].style, reason: "previous" };
  }
  const starter = acceptable[0];
  return starter
    ? { style: starter.style, reason: "starter" }
    : { style: null, reason: "no-fit" };
}
