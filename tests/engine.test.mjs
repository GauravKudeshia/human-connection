import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  applyAction,
  available,
  summarize,
} from "../lib/engine.mjs";
import { hosts } from "../lib/catalog.mjs";
const start = 1700000000000;
function runner() {
  let s = initialState();
  let i = 0;
  return {
    get s() {
      return s;
    },
    run(a, p = {}, t = start, key = `key-${++i}`) {
      const x = applyAction(s, a, p, key, t);
      s = x.state;
      return x.result;
    },
  };
}
function hold(r, hostId = "maya", t = start) {
  r.run("eligibility", { adult: true, us: true, terms: true }, t);
  return r.run(
    "hold",
    { hostId, duration: 15, format: "video", experience: "hear" },
    t,
  ).bookingId;
}
function paid(r) {
  const id = hold(r);
  r.run("accept", { bookingId: id });
  r.run("checkout", { bookingId: id });
  return id;
}
function completed(r) {
  const id = paid(r);
  r.run("join", { bookingId: id });
  r.run("complete-demo", { bookingId: id }, start + 20000);
  return id;
}
function balance(s) {
  for (const j of s.journals)
    assert.equal(
      j.lines.reduce((sum, l) => sum + l.debit - l.credit, 0),
      0,
    );
}
test("eligibility gates booking and malformed confirmations", () => {
  const r = runner();
  assert.throws(() => r.run("hold", { hostId: "maya" }), /eligibility/);
  assert.throws(
    () => r.run("eligibility", { adult: true, us: false, terms: true }),
    /Confirm adult/,
  );
});
test("T01 host exclusivity in serialized state; existing claim is unavailable", () => {
  const r = runner();
  hold(r);
  assert.equal(available(r.s, hosts[0]), false);
  assert.throws(
    () =>
      r.run("hold", {
        hostId: "maya",
        duration: 15,
        format: "video",
        experience: "hear",
      }),
    /no longer available/,
  );
  assert.equal(r.s.bookings.length, 1);
});
test("T02 expiry is checked on request without a cleanup worker", () => {
  const r = runner();
  const a = hold(r);
  const b = r.run(
    "hold",
    { hostId: "maya", duration: 15, format: "video", experience: "hear" },
    start + 31000,
  ).bookingId;
  assert.notEqual(a, b);
  assert.equal(r.s.bookings.find((x) => x.id === a).status, "EXPIRED");
});
test("T03 identical retry returns one booking", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  const p = {
    hostId: "maya",
    duration: 15,
    format: "video",
    experience: "hear",
  };
  const a = r.run("hold", p, start, "hold-key");
  const b = r.run("hold", p, start + 1, "hold-key");
  assert.deepEqual(a, b);
  assert.equal(r.s.bookings.length, 1);
});
test("T04 reused key with changed payload fails without mutation", () => {
  const r = runner();
  r.run("favorite", { hostId: "maya" }, start, "same");
  assert.throws(
    () => r.run("favorite", { hostId: "james" }, start, "same"),
    /different action/,
  );
  assert.deepEqual(r.s.favorites, ["maya"]);
});
test("T05 decline prevents checkout and releases claim", () => {
  const r = runner();
  const id = hold(r);
  r.run("decline", { bookingId: id });
  assert.throws(() => r.run("checkout", { bookingId: id }), /must accept/);
  assert.equal(available(r.s, hosts[0]), true);
  assert.equal(r.s.journals.length, 0);
});
test("expired acceptance cannot create payment or room", () => {
  const r = runner();
  const id = hold(r);
  r.run("accept", { bookingId: id });
  assert.throws(
    () => r.run("checkout", { bookingId: id }, start + 180001),
    /must accept/,
  );
  assert.equal(r.s.journals.length, 0);
});
test("client total is ignored and immutable server price used", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  const id = r.run("hold", {
    hostId: "maya",
    duration: 30,
    format: "video",
    experience: "hear",
    totalCents: 1,
  }).bookingId;
  assert.equal(r.s.bookings[0].totalCents, 1800);
  r.run("accept", { bookingId: id, totalCents: 2 });
  assert.equal(r.s.bookings[0].totalCents, 1800);
});
test("double checkout cannot charge twice", () => {
  const r = runner();
  const id = paid(r);
  assert.throws(() => r.run("checkout", { bookingId: id }), /must accept/);
  assert.equal(r.s.journals.length, 1);
  balance(r.s);
});
test("T10 cancellation before delivery reverses liability without host earnings", () => {
  const r = runner();
  const id = paid(r);
  r.run("cancel", { bookingId: id });
  balance(r.s);
  assert.equal(r.s.bookings[0].payment, "SIMULATED_REFUNDED");
  assert.equal(
    r.s.journals
      .flatMap((x) => x.lines)
      .some((l) => l.account === "host_base_payable"),
    false,
  );
});
test("T11 early exit opens review; refund adds compensating journal", () => {
  const r = runner();
  const id = paid(r);
  r.run("join", { bookingId: id });
  r.run("leave", { bookingId: id }, start + 60000);
  assert.equal(r.s.bookings[0].overlapSeconds, 60);
  assert.equal(r.s.refunds.length, 1);
  const original = structuredClone(r.s.journals);
  r.run(
    "refund-resolve",
    { refundId: r.s.refunds[0].id, reason: "Demo service interrupted" },
    start + 70000,
  );
  assert.deepEqual(r.s.journals.slice(0, 1), original);
  balance(r.s);
});
test("T12 completing session does not add any tip", () => {
  const r = runner();
  completed(r);
  assert.equal(r.s.bookings[0].tipCents, undefined);
  assert.equal(r.s.journals.length, 2);
});
test("T13 only one successful tip, host receives full principal", () => {
  const r = runner();
  const id = completed(r);
  r.run("tip", { bookingId: id, cents: 500 }, start + 21000, "tip");
  r.run("tip", { bookingId: id, cents: 500 }, start + 22000, "tip");
  assert.throws(
    () => r.run("tip", { bookingId: id, cents: 500 }, start + 23000),
    /already/,
  );
  assert.equal(r.s.journals.length, 3);
  const l = r.s.journals[2].lines.find((l) => l.account === "host_tip_payable");
  assert.equal(l.credit, 500);
  balance(r.s);
});
test("tip boundaries, integer cents, expiry and completion enforced", () => {
  const r = runner();
  const id = paid(r);
  assert.throws(() => r.run("tip", { bookingId: id, cents: 500 }), /completed/);
  r.run("join", { bookingId: id });
  r.run("complete-demo", { bookingId: id });
  for (const cents of [99, 5001, 100.5, NaN])
    assert.throws(() => r.run("tip", { bookingId: id, cents }), /between/);
  assert.throws(
    () => r.run("tip", { bookingId: id, cents: 500 }, start + 86400001),
    /24-hour/,
  );
});
test("T16 base and tip financial events balance; 70/30 base allocation", () => {
  const r = runner();
  const id = completed(r);
  r.run("tip", { bookingId: id, cents: 1000 }, start + 22000);
  balance(r.s);
  const lines = r.s.journals[1].lines;
  assert.equal(
    lines.find((l) => l.account === "host_base_payable").credit,
    700,
  );
  assert.equal(lines.find((l) => l.account === "platform_revenue").credit, 300);
});
test("room access requires checkout; blocked participant cannot rejoin", () => {
  const r = runner();
  const id = hold(r);
  assert.throws(() => r.run("join", { bookingId: id }), /confirmed/);
  r.run("accept", { bookingId: id });
  r.run("checkout", { bookingId: id });
  r.run("join", { bookingId: id });
  r.run("block", { hostId: "maya" }, start + 20000);
  assert.throws(
    () => r.run("reconnect", { bookingId: id }),
    /cannot reconnect/,
  );
});
test("T20 reconnect retains original deadline and overlap excludes drop", () => {
  const r = runner();
  const id = paid(r);
  r.run("join", { bookingId: id });
  const deadline = r.s.bookings[0].deadline;
  r.run("disconnect", { bookingId: id }, start + 10000);
  r.run("reconnect", { bookingId: id }, start + 20000);
  r.run("leave", { bookingId: id }, start + 30000);
  assert.equal(r.s.bookings[0].deadline, deadline);
  assert.equal(r.s.bookings[0].overlapSeconds, 20);
});
test("no timer at checkout and duplicate completion does not journal twice", () => {
  const r = runner();
  const id = paid(r);
  assert.equal(r.s.bookings[0].startedAt, undefined);
  r.run("join", { bookingId: id });
  r.run("complete-demo", { bookingId: id }, start + 10000, "finish");
  r.run("complete-demo", { bookingId: id }, start + 11000, "finish");
  assert.equal(r.s.journals.length, 2);
});
test("T23 urgent demo report ends call and creates auditable case", () => {
  const r = runner();
  const id = paid(r);
  r.run("join", { bookingId: id });
  r.run(
    "report",
    {
      hostId: "maya",
      bookingId: id,
      reason: "Test urgent report",
      urgent: true,
    },
    start + 10000,
  );
  assert.equal(r.s.bookings[0].status, "PARTIAL_DELIVERY");
  assert.equal(r.s.reports[0].status, "OPEN");
  assert.equal(r.s.audit[0].action, "report");
});
test("T24 new sessions blocked when safety coverage unavailable", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  r.run("operations", { setting: "staffed", value: false });
  assert.throws(
    () =>
      r.run("hold", {
        hostId: "maya",
        duration: 15,
        format: "video",
        experience: "hear",
      }),
    /safety coverage/,
  );
});
test("T25 blocking removes host; unblock restores availability", () => {
  const r = runner();
  r.run("block", { hostId: "maya" });
  assert.equal(available(r.s, hosts[0]), false);
  r.run("unblock", { hostId: "maya" });
  assert.equal(available(r.s, hosts[0]), true);
});
test("T29 demo closure clears public content and disallows new activity", () => {
  const r = runner();
  r.run("favorite", { hostId: "maya" });
  r.run("close-account");
  assert.equal(r.s.closed, true);
  assert.deepEqual(r.s.favorites, []);
  assert.throws(() => r.run("favorite", { hostId: "james" }), /closed/);
  r.run("reset");
  assert.equal(r.s.closed, false);
});
test("T32 simulated provider outage ends live session and opens recovery", () => {
  const r = runner();
  const id = paid(r);
  r.run("join", { bookingId: id });
  r.run(
    "operations",
    { setting: "providerHealthy", value: false },
    start + 10000,
  );
  assert.equal(r.s.bookings[0].status, "FAILED_SERVICE");
  assert.equal(r.s.refunds[0].status, "OPEN");
});
test("post-delivery refund preserves historical completion and reverses tip", () => {
  const r = runner();
  const id = completed(r);
  r.run("tip", { bookingId: id, cents: 500 }, start + 21000);
  r.run(
    "refund-request",
    { bookingId: id, reason: "Demo resolution" },
    start + 22000,
  );
  r.run(
    "refund-resolve",
    { refundId: r.s.refunds[0].id, reason: "Approved" },
    start + 23000,
  );
  assert.equal(r.s.bookings[0].status, "COMPLETED");
  assert.equal(r.s.bookings[0].tipRefunded, true);
  assert.equal(r.s.journals.length, 5);
  balance(r.s);
});
test("summaries hide request keys and disable live payments", () => {
  const r = runner();
  hold(r);
  const summary = summarize(r.s, start);
  assert.equal(summary.idempotency, undefined);
  assert.equal(summary.livePaymentsEnabled, false);
});
test("invalid duration, unsupported format, and experience fail", () => {
  const r = runner();
  r.run("eligibility", { adult: true, us: true, terms: true });
  for (const payload of [
    { hostId: "maya", duration: 60, format: "video", experience: "hear" },
    { hostId: "daniel", duration: 15, format: "video", experience: "laugh" },
    { hostId: "maya", duration: 15, format: "video", experience: "laugh" },
  ])
    assert.throws(() => r.run("hold", payload));
});
