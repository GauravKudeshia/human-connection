import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  applyAction,
  summarize,
  valueFeedbackSummary,
} from "../lib/engine.mjs";
import { activityRounds, activities } from "../lib/activities.mjs";
import { makeBrowserRequest } from "../pages/transport.mjs";
import { recommendStyle } from "../lib/style-recommendation.mjs";

function workspace() {
  let state = initialState();
  let now = 1_800_000_000_000;
  return {
    get state() {
      return state;
    },
    run(action, payload = {}, key = crypto.randomUUID()) {
      now += 100;
      const response = applyAction(state, action, payload, key, now);
      state = response.state;
      return response.result;
    },
  };
}
function prepared(w, experience = "hear", hostId = "maya") {
  w.run("eligibility", { adult: true, us: true, terms: true });
  const { bookingId } = w.run("hold", {
    hostId,
    experience,
    duration: 15,
    format: "audio",
    language: "English",
  });
  w.run("accept", { bookingId });
  w.run("checkout", { bookingId });
  return bookingId;
}
function completed(w) {
  const bookingId = prepared(w);
  w.run("join", { bookingId });
  w.run("complete-demo", { bookingId });
  return bookingId;
}

test("Surprise Me gives a catalog starting pick in every experience without usable history", () => {
  const history = [
    { experience: "laugh", style: "playful-banter", status: "CANCELLED", rating: 5 },
    { experience: "hear", style: "obsolete-style", status: "COMPLETED", rating: 5 },
  ];
  for (const [experience, style] of [
    ["laugh", "funny-stories"],
    ["hear", "my-day"],
    ["distract", "trivia-questions"],
  ])
    assert.deepEqual(recommendStyle(experience, history), { style, reason: "starter" });
});

test("Surprise Me stays inside today's experience and varies among positively rated styles", () => {
  const history = [
    { experience: "hear", style: "just-listen", status: "COMPLETED", rating: 5 },
    { experience: "laugh", style: "improv-games", status: "COMPLETED", rating: 5 },
    { experience: "laugh", style: "playful-banter", status: "COMPLETED", worthIt: true },
  ];
  assert.deepEqual(recommendStyle("laugh", history), {
    style: "playful-banter",
    reason: "liked",
  });
});

test("Surprise Me treats past choices as weaker evidence and avoids styles with recent negative feedback", () => {
  const history = [
    { experience: "laugh", style: "playful-banter", status: "COMPLETED", worthIt: false },
    { experience: "laugh", style: "playful-banter", status: "COMPLETED", rating: 5 },
    { experience: "laugh", style: "improv-games", status: "COMPLETED" },
  ];
  assert.deepEqual(recommendStyle("laugh", history), {
    style: "improv-games",
    reason: "previous",
  });
});

test("Surprise Me leaves the choice to the guest if every style has negative feedback", () => {
  const history = ["funny-stories", "playful-banter", "improv-games"].map((style) => ({
    experience: "laugh",
    style,
    status: "COMPLETED",
    rating: 1,
  }));
  assert.deepEqual(recommendStyle("laugh", history), { style: null, reason: "no-fit" });
});

test("value and private quality feedback preserve independent public ratings and one response per completed session", () => {
  const w = workspace();
  const bookingId = completed(w);
  w.run("rate", { bookingId, rating: 4, review: "Public fictional review" });
  w.run(
    "worth-it",
    { bookingId, answer: "yes", details: "Private value detail" },
    "first-value",
  );
  const originalCreated = w.state.bookings[0].valueFeedback.createdAt;
  w.run("quality-feedback", { bookingId, text: "Private quality detail" });
  w.run(
    "worth-it",
    { bookingId, answer: "yes", details: "Private value detail" },
    "first-value",
  );
  w.run("worth-it", {
    bookingId,
    answer: "no",
    details: "Updated value detail",
  });
  const b = w.state.bookings[0];
  assert.equal(b.rating, 4);
  assert.equal(b.review, "Public fictional review");
  assert.equal(b.valueFeedback.answer, "no");
  assert.equal(b.valueFeedback.createdAt, originalCreated);
  assert.equal(b.qualityFeedback.text, "Private quality detail");
  assert.equal(b.valueFeedback.simulated, true);
  assert.deepEqual(valueFeedbackSummary(w.state.bookings), {
    eligible: 1,
    answered: 1,
    yes: 0,
    skipped: 0,
  });
  assert.throws(
    () => w.run("worth-it", { bookingId, answer: "no" }, "first-value"),
    /different action/,
  );
});

test("value and private quality inputs reject unsupported answers, invalid text and undelivered states", () => {
  const w = workspace();
  const bookingId = completed(w);
  for (const status of [
    "READY",
    "DECLINED",
    "CANCELLED",
    "EXPIRED",
    "PARTIAL_DELIVERY",
    "FAILED_SERVICE",
  ]) {
    const state = structuredClone(w.state);
    state.bookings[0].status = status;
    for (const [action, payload] of [
      ["worth-it", { answer: "yes" }],
      ["quality-feedback", { text: "Fictional quality" }],
    ])
      assert.throws(() =>
        applyAction(
          state,
          action,
          { bookingId, ...payload },
          crypto.randomUUID(),
          state.bookings[0].endedAt + 1,
        ),
      );
  }
  for (const payload of [
    { answer: true },
    { answer: "maybe" },
    { answer: "yes", details: 9 },
    { answer: "no", details: "x".repeat(1001) },
  ])
    assert.throws(() => w.run("worth-it", { bookingId, ...payload }));
  assert.throws(() => w.run("quality-feedback", { bookingId, text: " " }));
  assert.throws(() =>
    w.run("quality-feedback", { bookingId, text: "x".repeat(1001) }),
  );
});

test("value metrics distinguish skipped, unanswered and eligible sessions with completion date bounds", () => {
  const w = workspace();
  const yesId = completed(w);
  w.run("worth-it", { bookingId: yesId, answer: "yes" });
  const firstTime = w.state.bookings[0].endedAt;
  const skipId = completed(w);
  w.run("worth-it", {
    bookingId: skipId,
    answer: "yes",
    details: "Remove on skip",
  });
  w.run("worth-it", {
    bookingId: skipId,
    answer: "skipped",
    details: "Discarded",
  });
  completed(w);
  const uncompleted = prepared(w);
  w.run("cancel", { bookingId: uncompleted });
  assert.equal(
    w.state.bookings.find((b) => b.id === skipId).valueFeedback.details,
    "",
  );
  assert.deepEqual(valueFeedbackSummary(w.state.bookings), {
    eligible: 3,
    answered: 1,
    yes: 1,
    skipped: 1,
  });
  assert.deepEqual(
    valueFeedbackSummary(w.state.bookings, firstTime, firstTime + 1),
    { eligible: 1, answered: 1, yes: 1, skipped: 0 },
  );
  assert.deepEqual(valueFeedbackSummary([], 0), {
    eligible: 0,
    answered: 0,
    yes: 0,
    skipped: 0,
  });
});

test("closure removes public, value and private quality narratives while retaining simulated financial history", () => {
  const w = workspace();
  const bookingId = completed(w);
  w.run("worth-it", {
    bookingId,
    answer: "yes",
    details: "Private value to remove",
  });
  w.run("quality-feedback", { bookingId, text: "Private quality to remove" });
  const journals = structuredClone(w.state.journals);
  w.run("close-account");
  assert.equal(w.state.bookings[0].valueFeedback, undefined);
  assert.equal(w.state.bookings[0].qualityFeedback, undefined);
  assert.equal(
    JSON.stringify(w.state).includes("Private value to remove"),
    false,
  );
  assert.equal(
    JSON.stringify(w.state).includes("Private quality to remove"),
    false,
  );
  assert.deepEqual(w.state.journals, journals);
});

test("activity progression validates revisions and selected context, and preserves one logical transition on retry", () => {
  const w = workspace();
  const bookingId = prepared(w, "distract", "sofia");
  w.run("select-activity", { bookingId, activityId: "distract-trivia" });
  const send = (command, key) =>
    w.run(
      "activity-action",
      {
        bookingId,
        activityId: "distract-trivia",
        revision: w.state.bookings[0].activityProgress.revision,
        command,
      },
      key,
    );
  const first = {
    bookingId,
    activityId: "distract-trivia",
    revision: 1,
    command: "next",
  };
  w.run("activity-action", first, "advance");
  w.run("activity-action", first, "advance");
  assert.equal(w.state.bookings[0].activityProgress.promptIndex, 1);
  assert.throws(() => w.run("activity-action", first), /activity has changed/);
  send("reveal");
  assert.equal(w.state.bookings[0].activityProgress.answerRevealed, true);
  send("hide");
  assert.equal(w.state.bookings[0].activityProgress.answerRevealed, false);
  send("next");
  assert.equal(w.state.bookings[0].activityProgress.promptIndex, 2);
  assert.throws(() => send("next"), /final prompt/);
  send("complete");
  assert.throws(() => send("reveal"), /activity is complete/);
  send("restart");
  assert.equal(w.state.bookings[0].activityProgress.promptIndex, 0);
  assert.equal(w.state.bookings[0].activityProgress.completed, false);
  w.run("select-activity", { bookingId, activityId: "distract-games" });
  assert.throws(() => send("next"), /current activity/);
  w.run("cancel", { bookingId });
  assert.throws(() => send("complete"), /Activities are available/);
});

test("older selected activities start at the first prompt and all experience decks preserve their original sample", () => {
  const w = workspace();
  const bookingId = prepared(w);
  w.run("select-activity", { bookingId, activityId: "hear-day" });
  delete w.state.bookings[0].activityProgress;
  w.run("activity-action", {
    bookingId,
    activityId: "hear-day",
    revision: 0,
    command: "next",
  });
  assert.equal(w.state.bookings[0].activityProgress.promptIndex, 1);
  assert.throws(
    () =>
      w.run("activity-action", {
        bookingId,
        activityId: "hear-day",
        revision: 1,
        command: "reveal",
      }),
    /no written answer/,
  );
  for (const activity of activities) {
    const rounds = activityRounds(activity);
    assert.equal(rounds[0].prompt, activity.prompt);
    assert.equal(rounds.length, 3);
  }
});

test("value answers and activity progress survive transport recreation and replay consistently", async () => {
  const map = new Map();
  const storage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
  };
  let request = makeBrowserRequest(storage, "evolution");
  const run = async (action, payload = {}, key = crypto.randomUUID()) => {
    const response = await request("/api/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ action, payload }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, body.error?.message);
    return body;
  };
  await run("eligibility", { adult: true, us: true, terms: true });
  const { result } = await run("hold", {
    hostId: "maya",
    experience: "hear",
    duration: 30,
    format: "video",
    language: "Spanish",
    style: "my-day",
  });
  const bookingId = result.bookingId;
  await run("accept", { bookingId });
  await run("checkout", { bookingId });
  await run("select-activity", { bookingId, activityId: "hear-day" });
  await run("activity-action", {
    bookingId,
    activityId: "hear-day",
    revision: 1,
    command: "next",
  });
  request = makeBrowserRequest(storage, "evolution");
  let saved = await (await request("/api/state")).json();
  assert.equal(saved.bookings[0].activityProgress.promptIndex, 1);
  await run("join", { bookingId });
  await run("complete-demo", { bookingId });
  await run("worth-it", { bookingId, answer: "yes" }, "value");
  request = makeBrowserRequest(storage, "evolution");
  saved = await (
    await run("worth-it", { bookingId, answer: "yes" }, "value")
  ).state;
  assert.equal(saved.bookings[0].valueFeedback.answer, "yes");
  assert.equal(saved.bookings[0].language, "Spanish");
  assert.equal(saved.bookings[0].duration, 30);
  assert.equal(saved.bookings[0].style, "my-day");
  assert.deepEqual(valueFeedbackSummary(saved.bookings), {
    eligible: 1,
    answered: 1,
    yes: 1,
    skipped: 0,
  });
  assert.equal(summarize(initialState()).livePaymentsEnabled, false);
});
