import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  initialState,
  applyAction,
  expire,
  available,
  summarize,
} from "../lib/engine.mjs";
import { hosts } from "../lib/catalog.mjs";
import { DEMO_RUNTIME } from "../lib/demo-policy.mjs";
import { rankMatches } from "../lib/matching.mjs";
import { receiptFor } from "../lib/receipts.mjs";
import { fingerprint } from "../lib/fingerprint.mjs";
import { makeBrowserRequest } from "../pages/transport.mjs";
const start = 1_700_000_000_000;
const prefs = {
  experience: "hear",
  style: "my-day",
  format: "audio",
  duration: 15,
  language: "English",
};
function runner() {
  let s = initialState(),
    sequence = 0;
  return {
    get s() {
      return s;
    },
    run(
      action,
      payload = {},
      now = start,
      key = `request-${++sequence}`,
      runtime = DEMO_RUNTIME,
    ) {
      const r = applyAction(s, action, payload, key, now, runtime);
      s = r.state;
      return r.result;
    },
  };
}
function paid(r, runtime = DEMO_RUNTIME) {
  r.run("eligibility", { adult: true, us: true, terms: true });
  const { bookingId } = r.run("hold", { ...prefs, hostId: "maya" });
  r.run("accept", { bookingId });
  r.run("checkout", { bookingId }, start, "checkout", runtime);
  return bookingId;
}
function completed(r) {
  const bookingId = paid(r);
  r.run("join", { bookingId });
  r.run("complete-demo", { bookingId }, start + 10_000);
  return bookingId;
}
function balanced(s) {
  for (const j of s.journals)
    assert.equal(
      j.lines.reduce((n, l) => n + l.debit - l.credit, 0),
      0,
    );
}

test("paid READY expires exactly at the snapshotted deadline, releases host, reverses once and remains auditable", () => {
  const r = runner();
  const id = paid(r);
  assert.equal(r.s.bookings[0].joinDeadlineAt, start + 180_000);
  assert.equal(
    expire(structuredClone(r.s), start + 179_999).bookings[0].status,
    "READY",
  );
  const s = expire(structuredClone(r.s), start + 180_000);
  assert.equal(s.bookings[0].status, "EXPIRED");
  assert.equal(s.bookings[0].payment, "SIMULATED_REFUNDED");
  assert.ok(available(s, hosts[0]));
  assert.match(s.bookings[0].customerMessage, /fully reversed/);
  assert.equal(s.refunds[0].status, "REFUNDED");
  assert.equal(
    s.audit.filter((a) => a.action === "paid-reservation-expired").length,
    1,
  );
  expire(s, start + 190_000);
  assert.equal(s.journals.filter((j) => j.event === "refund:" + id).length, 1);
  balanced(s);
  assert.equal(
    s.journals
      .flatMap((j) => j.lines)
      .some((l) => l.account === "host_base_payable"),
    false,
  );
  assert.throws(
    () => applyAction(s, "join", { bookingId: id }, "late", start + 190_000),
    /confirmed demo checkout/,
  );
  const replay = applyAction(
    s,
    "checkout",
    { bookingId: id },
    "checkout",
    start + 190_001,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.bookings[0].status, "EXPIRED");
  assert.equal(replay.state.journals.length, 2);
});
test("join deadline is configurable by runtime and cannot be extended by checkout input or changed configuration", () => {
  const r = runner(),
    id = paid(r, { mode: "demo", joinDeadlineMs: 10_000 });
  assert.equal(r.s.bookings[0].joinDeadlineAt, start + 10_000);
  assert.equal(
    expire(structuredClone(r.s), start + 10_000).bookings[0].status,
    "EXPIRED",
  );
  assert.throws(
    () => r.run("checkout", { bookingId: id, joinDeadlineAt: start + 999999 }),
    /must accept/,
  );
});
test("old schema-1 READY records get a deterministic deadline without deleting history", () => {
  const r = runner();
  paid(r);
  delete r.s.bookings[0].joinDeadlineAt;
  delete r.s.mode;
  delete r.s.matching;
  delete r.s.feedback;
  const original = structuredClone(r.s.journals[0]);
  const migrated = expire(structuredClone(r.s), start + 180_001);
  assert.equal(migrated.bookings.length, 1);
  assert.equal(migrated.bookings[0].status, "EXPIRED");
  assert.deepEqual(migrated.journals[0], original);
});
test("late join failures persist expiry/refund across transport reload, retry and a later new reservation", async () => {
  const values = new Map(),
    storage = {
      getItem: (k) => values.get(k) || null,
      setItem: (k, v) => values.set(k, v),
    };
  const r = runner(),
    id = paid(r);
  storage.setItem("test", JSON.stringify(r.s));
  let now = start + 180_000;
  const request = makeBrowserRequest(storage, "test", () => now);
  const post = (action, payload, key = crypto.randomUUID()) =>
    request("/api/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ action, payload }),
    });
  assert.equal((await post("join", { bookingId: id })).status, 409);
  let saved = JSON.parse(storage.getItem("test"));
  assert.equal(saved.bookings[0].payment, "SIMULATED_REFUNDED");
  assert.equal(saved.journals.length, 2);
  const retry = await post("checkout", { bookingId: id }, "checkout");
  assert.equal(retry.status, 200);
  now += 10;
  const reload = makeBrowserRequest(storage, "test", () => now);
  saved = await (await reload("/api/state")).json();
  assert.equal(saved.journals.length, 2);
  assert.equal(saved.bookings[0].status, "EXPIRED");
  assert.equal((await post("hold", { ...prefs, hostId: "maya" })).status, 200);
  assert.equal((await post("hold", { ...prefs, hostId: "maya" })).status, 409);
});
test("cancelled, declined, expired, partial and failed sessions cannot receive delivered-service ratings", () => {
  for (const status of [
    "CANCELLED",
    "DECLINED",
    "EXPIRED",
    "PARTIAL_DELIVERY",
    "FAILED_SERVICE",
  ]) {
    const r = runner(),
      id = paid(r);
    r.s.bookings[0].status = status;
    r.s.bookings[0].endedAt = start;
    assert.throws(
      () =>
        r.run("rate", { bookingId: id, rating: 5, review: "not delivered" }),
      /completed, delivered/,
    );
    r.run("service-feedback", {
      bookingId: id,
      text: "The demo did not deliver.",
    });
    r.run("service-feedback", {
      bookingId: id,
      text: "Updated service feedback.",
    });
    assert.equal(r.s.feedback.length, 1);
    assert.equal(r.s.bookings[0].rating, undefined);
  }
});
test("completed ratings support one logical review and idempotent edits without inflated counts", () => {
  const r = runner(),
    id = completed(r);
  const payload = { bookingId: id, rating: 4, review: "Demo review" };
  r.run("rate", payload, start + 11000, "review");
  r.run("rate", payload, start + 12000, "review");
  r.run("rate", { ...payload, rating: 5 }, start + 13000);
  assert.equal(r.s.bookings.filter((b) => b.rating).length, 1);
  assert.equal(r.s.bookings[0].rating, 5);
  assert.throws(
    () => r.run("service-feedback", { bookingId: id, text: "not failed" }),
    /undelivered/,
  );
  assert.throws(
    () => r.run("rate", { bookingId: id, rating: 6 }),
    /one to five/,
  );
});
test("legacy undelivered ratings migrate to failure feedback and do not appear as host reviews", () => {
  const r = runner(),
    id = paid(r);
  r.run("cancel", { bookingId: id });
  r.s.bookings[0].rating = 1;
  r.s.bookings[0].review = "Legacy failure note";
  const state = expire(structuredClone(r.s), start + 10);
  assert.equal(state.bookings[0].rating, undefined);
  assert.equal(state.feedback[0].text, "Legacy failure note");
  expire(state, start + 20);
  assert.equal(state.feedback.length, 1);
});
test("receipts preserve original base/tip and show both refunds with zero net; refunds stay balanced and unique", () => {
  const r = runner(),
    id = completed(r);
  r.run("tip", { bookingId: id, cents: 500 }, start + 11000);
  assert.deepEqual(receiptFor(r.s.bookings[0]), {
    baseCharge: 1000,
    baseRefund: 0,
    tipCharge: 500,
    tipRefund: 0,
    net: 1500,
    sessionStatus: "COMPLETED",
    paymentStatus: "SIMULATED_SUCCEEDED",
    realCharge: 0,
  });
  r.run(
    "refund-request",
    { bookingId: id, reason: "Demo resolution" },
    start + 12000,
  );
  const refundId = r.s.refunds[0].id;
  r.run(
    "refund-resolve",
    { refundId, reason: "Full demo refund" },
    start + 13000,
    "refund",
  );
  r.run(
    "refund-resolve",
    { refundId, reason: "Full demo refund" },
    start + 14000,
    "refund",
  );
  assert.equal(r.s.journals.length, 5);
  assert.equal(r.s.bookings[0].status, "COMPLETED");
  assert.deepEqual(receiptFor(r.s.bookings[0]), {
    baseCharge: 1000,
    baseRefund: 1000,
    tipCharge: 500,
    tipRefund: 500,
    net: 0,
    sessionStatus: "COMPLETED",
    paymentStatus: "SIMULATED_REFUNDED",
    realCharge: 0,
  });
  balanced(r.s);
  r.run(
    "refund-feedback",
    { bookingId: id, text: "The reversal was clear." },
    start + 15000,
  );
  assert.equal(r.s.bookings[0].rating, undefined);
  assert.equal(r.s.feedback.length, 0);
  assert.ok(r.s.bookings[0].refundFeedback);
  assert.throws(
    () => r.run("tip", { bookingId: id, cents: 200 }, start + 16000),
    /completed paid/,
  );
});
test("unpaid receipts never imply a base charge", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  r.run("hold", { ...prefs, hostId: "maya" });
  assert.equal(receiptFor(r.s.bookings[0]).baseCharge, 0);
  assert.equal(receiptFor(r.s.bookings[0]).net, 0);
});
test("report relationship validation rejects unknown and mismatched hosts/bookings without changing a session", () => {
  const r = runner(),
    id = paid(r);
  r.run("join", { bookingId: id });
  for (const payload of [
    { hostId: "james", bookingId: id },
    { hostId: "maya", bookingId: "missing" },
    { hostId: "unknown", bookingId: id },
  ])
    assert.throws(() =>
      r.run("report", { ...payload, reason: "Test concern", urgent: true }),
    );
  assert.equal(r.s.bookings[0].status, "LIVE");
  assert.equal(r.s.reports.length, 0);
  r.run(
    "report",
    {
      hostId: "maya",
      bookingId: id,
      reason: "Valid demo concern",
      urgent: true,
    },
    start + 1000,
  );
  assert.equal(r.s.bookings[0].status, "PARTIAL_DELIVERY");
});
test("matching honors experience, style, format, language, offline hosts and blocks", () => {
  const s = initialState();
  let matches = rankMatches(s, prefs).matches;
  assert.equal(matches[0].host.id, "aisha");
  matches = rankMatches(s, { ...prefs, language: "Spanish" }).matches;
  assert.deepEqual(
    matches.map((m) => m.host.id),
    ["maya", "sofia"],
  );
  assert.ok(
    rankMatches(s, {
      ...prefs,
      experience: "laugh",
      style: "playful-banter",
      format: "audio",
    }).matches[0].host.id === "daniel",
  );
  assert.ok(
    rankMatches(s, {
      ...prefs,
      experience: "laugh",
      style: null,
      format: "video",
    }).matches.every((m) => m.host.id !== "daniel"),
  );
  s.blocks = ["maya"];
  s.hostOnline.sofia = false;
  assert.equal(
    rankMatches(s, { ...prefs, language: "Spanish" }).matches.length,
    0,
  );
  assert.equal(
    rankMatches(s, { ...prefs, experience: "laugh", style: "just-listen" })
      .matches.length,
    0,
  );
});
test("matching never reserves or charges unavailable hosts and checks account/active-reservation state", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  const impossible = {
    ...prefs,
    experience: "laugh",
    style: null,
    language: "Spanish",
  };
  assert.throws(
    () => r.run("match", impossible),
    (error) => error.code === "NO_MATCH",
  );
  assert.equal(r.s.bookings.length, 0);
  assert.equal(r.s.journals.length, 0);
  const result = r.run("match", prefs);
  assert.ok(result.bookingId);
  assert.throws(() => r.run("match", prefs), /in progress/);
  r.run("cancel", result);
  r.run("close-account");
  assert.equal(rankMatches(r.s, prefs).matches.length, 0);
  assert.throws(() => r.run("match", prefs), /closed/);
});
test("fair matching rotates equal-style hosts by local request counts and retries do not alter fairness", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  const first = r.run("match", prefs, start, "first");
  r.run("match", prefs, start + 1, "first");
  const firstHost = r.s.bookings[0].hostId;
  assert.equal(r.s.matching.counts[firstHost], 1);
  r.run("decline", first);
  const second = r.run("match", prefs, start + 10);
  assert.notEqual(r.s.bookings[0].hostId, firstHost);
  r.run("decline", second);
  const chosen = rankMatches(r.s, prefs).matches[0].host.id;
  assert.equal(chosen, firstHost);
});
test("reservation input validates language/style/duration, ignores spoofed price and blocks second simultaneous request", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  for (const extra of [
    { language: "Unknown" },
    { style: "improv-games" },
    { duration: 60 },
  ])
    assert.throws(() => r.run("hold", { ...prefs, hostId: "maya", ...extra }));
  r.run("hold", { ...prefs, hostId: "maya", duration: 30, totalCents: 1 });
  assert.equal(r.s.bookings[0].totalCents, 1800);
  assert.throws(
    () => r.run("hold", { ...prefs, hostId: "aisha" }),
    /current request/,
  );
});
test("blocking removes a favorite, prevents matching, and cannot be bypassed by bookmarking", () => {
  const r = runner();
  r.run("favorite", { hostId: "maya" });
  r.run("block", { hostId: "maya" });
  assert.deepEqual(r.s.favorites, []);
  assert.ok(rankMatches(r.s, prefs).matches.every((m) => m.host.id !== "maya"));
  assert.throws(() => r.run("favorite", { hostId: "maya" }), /Unblock/);
  r.run("unblock", { hostId: "maya" });
  assert.ok(rankMatches(r.s, prefs).matches.some((m) => m.host.id === "maya"));
});
test("activity selection is optional, compatible with experience, and survives state summaries/retries", () => {
  const r = runner(),
    id = paid(r);
  const pick = { bookingId: id, activityId: "hear-day" };
  r.run("select-activity", pick, start, "activity");
  r.run("select-activity", pick, start + 1, "activity");
  assert.equal(summarize(r.s, start + 2).bookings[0].activityId, "hear-day");
  assert.throws(
    () => r.run("select-activity", { ...pick, activityId: "laugh-story" }),
    /this experience/,
  );
  r.run("select-activity", { bookingId: id, activityId: null });
  assert.equal(r.s.bookings[0].activityId, null);
  r.run("join", { bookingId: id });
  r.run("complete-demo", { bookingId: id });
  assert.throws(() => r.run("select-activity", pick), /preparing/);
});
test("automatic end does not recognize a full delivery after reconnecting near the original deadline", () => {
  const r = runner(),
    id = paid(r);
  r.run("join", { bookingId: id });
  r.run("disconnect", { bookingId: id }, start + 10000);
  r.run("reconnect", { bookingId: id }, start + 890000);
  const s = expire(structuredClone(r.s), start + 901000);
  assert.equal(s.bookings[0].status, "PARTIAL_DELIVERY");
  assert.equal(s.bookings[0].overlapSeconds, 20);
  assert.equal(s.refunds.length, 1);
  assert.equal(s.journals.length, 1);
});
test("uninterrupted automatic completion caps overlap at the agreed duration", () => {
  const r = runner(),
    id = paid(r);
  r.run("join", { bookingId: id });
  const s = expire(structuredClone(r.s), start + 950000);
  assert.equal(s.bookings[0].status, "COMPLETED");
  assert.equal(s.bookings[0].overlapSeconds, 900);
  assert.equal(s.journals.length, 2);
});
test("simulation entry points reject non-demo runtime and never enable production capabilities through input", () => {
  const r = runner(),
    id = completed(r);
  for (const action of [
    "checkout",
    "tip",
    "complete-demo",
    "accept",
    "operations",
    "refund-resolve",
    "presence",
  ])
    assert.throws(
      () =>
        applyAction(
          r.s,
          action,
          { bookingId: id },
          "production",
          start + 20000,
          { mode: "production", joinDeadlineMs: 180000 },
        ),
      (error) => error.code === "DEMO_ONLY",
    );
  r.run("operations", {
    setting: "providerHealthy",
    value: true,
    livePaymentsEnabled: true,
    mode: "production",
  });
  const s = summarize(r.s, start + 20000);
  assert.equal(s.demo, true);
  assert.equal(s.livePaymentsEnabled, false);
  assert.equal(s.liveCallsEnabled, false);
  assert.equal(s.staffSafetyEnabled, false);
  assert.throws(
    () => r.run("provider-charge", { cents: 1000 }),
    /Production provider operations/,
  );
});
test("replay digests match standard SHA-256 and do not retain raw report narratives", () => {
  for (const text of ["", "abc", "hello 🌿 café", "x".repeat(10000)])
    assert.equal(
      fingerprint(text),
      createHash("sha256").update(text).digest("hex"),
    );
  const r = runner();
  r.run(
    "report",
    { hostId: "maya", reason: "Private fictional narrative" },
    start,
    "report",
  );
  assert.equal(
    JSON.stringify(r.s.idempotency).includes("Private fictional narrative"),
    false,
  );
  r.run(
    "report",
    { hostId: "maya", reason: "Private fictional narrative" },
    start + 1,
    "report",
  );
  assert.equal(r.s.reports.length, 1);
  r.run("close-account");
  assert.equal(
    JSON.stringify(r.s).includes("Private fictional narrative"),
    false,
  );
});
test("opaque replay keys cannot use object prototype properties to bypass validation", () => {
  const r = runner();
  for (const key of ["__proto__", "constructor", "toString"]) {
    r.run("favorite", { hostId: "maya" }, start, key);
    r.run("favorite", { hostId: "maya" }, start + 1, key);
    assert.throws(
      () => r.run("favorite", { hostId: "james" }, start + 2, key),
      /different action/,
    );
  }
});
test("old narrative-bearing fingerprints migrate without losing same-request retry behavior", () => {
  const r = runner();
  const payload = { hostId: "maya", reason: "Legacy note" };
  r.run("report", payload, start, "legacy");
  r.s.idempotency.legacy.fingerprint = JSON.stringify({
    action: "report",
    payload,
  });
  r.run("report", payload, start + 1, "legacy");
  assert.equal(r.s.reports.length, 1);
  assert.equal(r.s.idempotency.legacy.fingerprint.length, 64);
});

test("host application preview preserves review gates and never creates a real host", () => {
  const r = runner();
  const before = hosts.length;
  r.run("apply", {
    adult: true,
    name: "Fictional applicant",
    bio: "Sample host application for QA.",
  });
  assert.throws(
    () => r.run("apply", { adult: true, name: "Duplicate", bio: "Duplicate" }),
    /already/,
  );
  const applicationId = r.s.applications[0].id;
  r.run("application-decision", {
    applicationId,
    status: "TRAINING_REQUIRED",
    reason: "Demo training step.",
  });
  assert.equal(r.s.applications[0].status, "TRAINING_REQUIRED");
  assert.equal(hosts.length, before);
  assert.throws(
    () =>
      r.run("application-decision", {
        applicationId,
        status: "APPROVED",
        reason: "Bypass",
      }),
    /valid decision/,
  );
});
