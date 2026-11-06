import test from "node:test";
import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:4193";
let cookie = "";
async function action(
  action,
  payload = {},
  key = crypto.randomUUID(),
  origin = base,
) {
  return fetch(base + "/api/action", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ action, payload }),
  });
}
test("HTTP integration: auth, CSRF, concurrency, persistence and financial lifecycle", async () => {
  const unauth = await fetch(base + "/api/state");
  assert.equal(unauth.status, 401);
  const login = await fetch(base + "/signin-with-chatgpt?return_to=/", {
    redirect: "manual",
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
  const denied = await action(
    "favorite",
    { hostId: "maya" },
    undefined,
    "https://foreign.example",
  );
  assert.equal(denied.status, 403);

  for (const body of [
    "null",
    "[]",
    "{bad",
    '{"action":"favorite","payload":[]}',
  ]) {
    const invalid = await fetch(base + "/api/action", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body,
    });
    assert.equal(invalid.status, 400);
  }
  const oversized = await fetch(base + "/api/action", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: "x".repeat(12001),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await action("reset")).status, 200);
  assert.equal(
    (await action("eligibility", { adult: true, us: true, terms: true }))
      .status,
    200,
  );
  const payload = {
    hostId: "maya",
    duration: 15,
    experience: "hear",
    format: "video",
  };
  const concurrent = await Promise.all([
    action("hold", payload),
    action("hold", payload),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  const success = await concurrent.find((r) => r.status === 200).json();
  const id = success.result.bookingId;
  assert.equal((await action("accept", { bookingId: id })).status, 200);
  const key = crypto.randomUUID();
  const checks = await Promise.all([
    action("checkout", { bookingId: id }, key),
    action("checkout", { bookingId: id }, key),
  ]);
  assert.ok(checks.every((r) => r.status === 200));
  let state = await (
    await fetch(base + "/api/state", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(state.journals.length, 1);
  assert.equal(state.bookings[0].status, "READY");
  assert.equal(
    state.bookings[0].joinDeadlineAt - state.bookings[0].paidAt,
    180000,
  );
  assert.equal(state.liveCallsEnabled, false);
  assert.equal(state.staffSafetyEnabled, false);
  assert.equal(
    (await action("rate", { bookingId: id, rating: 5 })).status,
    409,
  );
  assert.equal(
    (
      await action("report", {
        hostId: "james",
        bookingId: id,
        reason: "Mismatched demo report",
      })
    ).status,
    409,
  );
  assert.equal(
    (await action("select-activity", { bookingId: id, activityId: "hear-day" }))
      .status,
    200,
  );
  assert.equal((await action("join", { bookingId: id })).status, 200);
  assert.equal((await action("complete-demo", { bookingId: id })).status, 200);
  const tips = await Promise.all([
    action("tip", { bookingId: id, cents: 500 }),
    action("tip", { bookingId: id, cents: 500 }),
  ]);
  assert.deepEqual(tips.map((r) => r.status).sort(), [200, 409]);
  state = await (
    await fetch(base + "/api/state", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(state.journals.length, 3);
  assert.equal(state.bookings[0].tipCents, 500);
  assert.equal(state.idempotency, undefined);
  for (const j of state.journals)
    assert.equal(
      j.lines.reduce((n, l) => n + l.debit - l.credit, 0),
      0,
    );
  assert.equal(
    (
      await action("rate", {
        bookingId: id,
        rating: 5,
        review: "Test demo review",
      })
    ).status,
    200,
  );
  assert.equal((await action("favorite", { hostId: "maya" })).status, 200);
  state = await (
    await fetch(base + "/api/state", { headers: { Cookie: cookie } })
  ).json();
  assert.deepEqual(state.favorites, ["maya"]);
  console.log(
    "Verified malformed/oversized request rejection, READY deadline, delivered rating gate, report relationship, activity persistence, disabled production capabilities, 401 auth, 403 CSRF, atomic concurrent reservation, idempotent checkout, one logical tip, balanced journals, durable favorites.",
  );
});
