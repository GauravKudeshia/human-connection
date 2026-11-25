import { bookableStylesFor, stylesFor } from "./catalog.mjs";

export const styleRecommendationMessages = {
  liked: "You gave positive feedback after a session with this style.",
  previous: "You’ve chosen this style before.",
  starter: "A starting pick for this experience.",
  "no-fit": "Choose the style that feels right today.",
};

function feedback(booking) {
  if (
    booking.worthIt === false ||
    (booking.rating >= 1 && booking.rating <= 2) ||
    (booking.comfortRating >= 1 && booking.comfortRating <= 2)
  )
    return "negative";
  if (booking.worthIt === true || (booking.rating >= 4 && booking.rating <= 5))
    return "positive";
  return null;
}

// History is newest first. Callers supply structured choices and ratings only.
function recommend(options, history) {
  const valid = new Map(options.map(({ style, experience }) => [style, experience]));
  const recent = history
    .filter(
      (booking) =>
        booking.status === "COMPLETED" &&
        valid.has(booking.style) &&
        valid.get(booking.style) === booking.experience,
    )
    .slice(0, 12);
  const candidates = options.map(({ style, experience, starter }) => {
    const visits = recent.filter((booking) => booking.style === style);
    return {
      style,
      experience,
      starter,
      feedback: visits.map(feedback).find(Boolean),
      count: visits.length,
      lastVisit: recent.findIndex((booking) => booking.style === style),
    };
  });
  const liked = candidates.filter((choice) => choice.feedback === "positive");
  // Prefer a different liked style if the latest session was also a good fit.
  const variety =
    liked.length > 1 ? liked.filter((choice) => choice.lastVisit !== 0) : liked;
  if (variety.length) {
    variety.sort((a, b) => b.count - a.count || a.lastVisit - b.lastVisit);
    const { style, experience } = variety[0];
    return { style, experience, reason: "liked" };
  }
  const acceptable = candidates.filter((choice) => choice.feedback !== "negative");
  const familiar = acceptable.filter((choice) => choice.count > 0);
  if (familiar.length) {
    familiar.sort((a, b) => b.count - a.count || a.lastVisit - b.lastVisit);
    const { style, experience } = familiar[0];
    return { style, experience, reason: "previous" };
  }
  const starter = acceptable.find((choice) => choice.starter);
  return starter
    ? { style: starter.style, experience: starter.experience, reason: "starter" }
    : { style: null, experience: null, reason: "no-fit" };
}

function choicesFor(experience) {
  const starters = new Set(bookableStylesFor(experience).map(({ id }) => id));
  return stylesFor(experience).map(({ id }) => ({
    style: id,
    experience,
    starter: starters.has(id),
  }));
}

export function recommendStyle(experience, history = []) {
  const { style, reason } = recommend(choicesFor(experience), history);
  return { style, reason };
}

export function recommendMoment(history = []) {
  return recommend(["distract", "hear", "laugh"].flatMap(choicesFor), history);
}
