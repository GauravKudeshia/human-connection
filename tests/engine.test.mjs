import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  applyAction,
  available,
  summarize,
} from "../lib/engine.mjs";
import { hosts } from "../lib/catalog.mjs";
import { makeBrowserRequest } from "../pages/transport.mjs";
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
function live(r) {
  const bookingId = paid(r);
  r.run("join", { bookingId });
  return bookingId;
}
function issueInvite(r, bookingId, time = start) {
  r.run("invite-request", { bookingId }, time);
  r.run("invite-host-approve", { bookingId }, time);
  return r.run("invite-issue", { bookingId }, time, "issue-demo-link");
}
const guestTerms = { adult: true, terms: true };

test("demo guest entry requires paid live state, host approval, link, guest terms and customer admission in order", () => {
  const r = runner();
  const bookingId = paid(r);
  const room = { bookingId };
  assert.throws(() => r.run("invite-request", room), /active paid demo room/);
  r.run("join", room);
  const original = { ...r.s.bookings[0] };
  r.run("invite-request", room);
  for (const action of ["invite-request", "invite-issue", "invite-guest-join"])
    assert.throws(() => r.run(action, room), /current invitation step/);
  r.run("invite-host-approve", room);
  const { invitationToken, expiresAt } = r.run("invite-issue", room, start, "issue");
  assert.match(invitationToken, /^[0-9a-f]{48}$/);
  assert.equal(expiresAt, start + 180_000);
  assert(!JSON.stringify(r.s).includes(invitationToken));
  assert(!JSON.stringify(summarize(r.s, start)).includes("tokenDigest"));
  const replay = r.run("invite-issue", room, start + 1, "issue");
  assert.deepEqual(replay, { invitationStatus: "ISSUED", expiresAt });
  assert.throws(
    () => r.run("invite-guest-open", { ...room, token: "a".repeat(48) }),
    /does not belong/,
  );
  r.run("invite-guest-open", { ...room, token: invitationToken });
  assert.throws(() => r.run("invite-guest-open", { ...room, token: invitationToken }), /current invitation step/);
  assert.throws(() => r.run("invite-admit", room), /current invitation step/);
  assert.throws(
    () => r.run("invite-guest-consent", { ...room, ...guestTerms, adult: false }),
    /Confirm the demo guest/,
  );
  assert.throws(
    () => r.run("invite-guest-consent", { ...room, ...guestTerms, terms: false }),
    /Confirm the demo guest/,
  );
  r.run("invite-guest-consent", { ...room, ...guestTerms });
  assert.throws(() => r.run("invite-guest-join", room), /current invitation step/);
  assert.throws(() => r.run("invite-guest-report", { ...room, reason: "Concern" }), /admitted guest/);
  assert.equal(r.s.bookings[0].invitation.status, "GUEST_WAITING");
  r.run("invite-admit", room, start + 3, "admit");
  assert.deepEqual(r.run("invite-admit", room, start + 4, "admit"), { invitationStatus: "GUEST_ADMITTED" });
  assert.throws(() => r.run("invite-admit", room), /current invitation step/);
  r.run("invite-guest-join", room);
  assert.throws(() => r.run("invite-guest-join", room), /current invitation step/);
  const { caseId } = r.run("invite-guest-report", { ...room, reason: "Fictional demo concern" });
  assert(r.s.reports.some((report) => report.id === caseId && report.fromDemoGuest));
  for (const field of ["startedAt", "deadline", "totalCents", "payment"])
    assert.equal(r.s.bookings[0][field], original[field]);
  assert.equal(r.s.journals.length, 1);
  assert.equal(r.s.bookings[0].invitation.status, "GUEST_CONNECTED");
  r.run("complete-demo", room, start + 20_000);
  assert.equal(r.s.bookings[0].invitation.status, "SESSION_ENDED");
  assert.equal(r.s.journals.length, 2);
  assert(r.s.journals.some(({ event, lines }) =>
    event === "delivered:" + bookingId &&
    lines.some(({ account, credit }) => account === "host_base_payable" && credit === 700),
  ));
});

test("demo host and customer declines close the invitation without creating an extra participant", () => {
  const host = runner();
  const hostRoom = { bookingId: live(host) };
  host.run("invite-request", hostRoom);
  host.run("invite-host-decline", hostRoom);
  assert.equal(host.s.bookings[0].invitation.status, "HOST_DECLINED");
  assert.throws(() => host.run("invite-issue", hostRoom), /current invitation step/);

  const customer = runner();
  const room = { bookingId: live(customer) };
  const { invitationToken } = issueInvite(customer, room.bookingId);
  customer.run("invite-guest-open", { ...room, token: invitationToken });
  customer.run("invite-guest-consent", { ...room, ...guestTerms });
  customer.run("invite-customer-decline", room);
  assert.equal(customer.s.bookings[0].invitation.status, "CUSTOMER_DECLINED");
  assert.throws(() => customer.run("invite-guest-join", room), /current invitation step/);
  assert.equal(customer.s.journals.length, 1);
});

test("demo link replacement, host withdrawal, and customer cancellation invalidate unused links", () => {
  for (const revoke of ["invite-host-withdraw", "invite-cancel"]) {
    const r = runner();
    const room = { bookingId: live(r) };
    const first = issueInvite(r, room.bookingId);
    const second = r.run("invite-issue", room, start + 100);
    assert.notEqual(second.invitationToken, first.invitationToken);
    assert.equal(second.expiresAt, first.expiresAt);
    assert.throws(
      () => r.run("invite-guest-open", { ...room, token: first.invitationToken }, start + 100),
      /does not belong/,
    );
    r.run(revoke, room, start + 120);
    assert.equal(r.s.bookings[0].invitation.status, "REVOKED");
    assert.throws(
      () => r.run("invite-guest-open", { ...room, token: second.invitationToken }, start + 120),
      /current invitation step/,
    );
  }
});

test("invite expiry, guest removal, and reconnect preserve the original session clock", () => {
  const r = runner();
  const room = { bookingId: live(r) };
  const { invitationToken, expiresAt } = issueInvite(r, room.bookingId);
  const deadline = r.s.bookings[0].deadline;
  assert.equal(
    summarize(r.s, expiresAt).bookings[0].invitation.status,
    "EXPIRED",
  );
  assert.throws(
    () => r.run("invite-guest-open", { ...room, token: invitationToken }, expiresAt),
    /current invitation step/,
  );
  r.run("invite-guest-open", { ...room, token: invitationToken }, start + 500);
  r.run("invite-guest-consent", { ...room, ...guestTerms }, start + 500);
  r.run("invite-admit", room, start + 500);
  r.run("invite-guest-join", room, start + 500);
  r.run("invite-guest-disconnect", room, start + 600);
  r.run("disconnect", room, start + 1000);
  assert.throws(() => r.run("invite-guest-reconnect", room, start + 1100), /active paid demo room/);
  r.run("reconnect", room, start + 1500);
  r.run("invite-guest-reconnect", room, start + 1600);
  assert.equal(r.s.bookings[0].invitation.status, "GUEST_CONNECTED");
  r.run("invite-remove", room, start + 1700);
  assert.equal(r.s.bookings[0].invitation.status, "GUEST_REMOVED");
  assert.equal(r.s.bookings[0].deadline, deadline);
  assert.throws(() => r.run("invite-guest-reconnect", room, start + 1800), /current invitation step/);
  assert.throws(() => r.run("invite-guest-report", { ...room, reason: "Concern" }, start + 1800), /admitted guest/);
  assert.equal(summarize(r.s, deadline).bookings[0].status, "PARTIAL_DELIVERY");
});

test("the demo transport rejects forwarded links in a separate workspace and serializes admission", async () => {
  const request = makeBrowserRequest(null, "original", () => start);
  const forwarded = makeBrowserRequest(null, "other", () => start);
  const send = (transport, action, payload) =>
    transport("/api/action", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action, payload }),
    });
  const perform = async (action, payload) => {
    const response = await send(request, action, payload);
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  await perform("eligibility", guestTerms);
  const room = await perform("hold", {
    hostId: "maya", duration: 15, format: "video", experience: "hear",
  });
  for (const action of ["accept", "checkout", "join", "invite-request", "invite-host-approve"])
    await perform(action, room);
  const { invitationToken } = await perform("invite-issue", room);
  const linkInput = { ...room, token: invitationToken };
  assert.equal((await send(forwarded, "invite-guest-open", linkInput)).status, 404);
  await perform("invite-guest-open", linkInput);
  await perform("invite-guest-consent", { ...room, ...guestTerms });
  const admissions = await Promise.all([send(request, "invite-admit", room), send(request, "invite-admit", room)]);
  assert.deepEqual(admissions.map(({ status }) => status).sort(), [200, 409]);
  await perform("invite-guest-join", room);
  await perform("invite-guest-leave", room);
  const state = await (await request("/api/state")).json();
  assert.equal(state.bookings[0].invitation.status, "GUEST_LEFT");
  assert.equal(state.bookings[0].status, "LIVE");
});
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
test("demo booking requires age and terms and accepts location-free and legacy confirmations", () => {
  const r = runner();
  assert.throws(() => r.run("hold", { hostId: "maya" }), /eligibility/);
  assert.throws(
    () => r.run("eligibility", { adult: false, terms: true }),
    /Confirm you are 18/,
  );
  assert.throws(
    () => r.run("eligibility", { adult: true, terms: false }),
    /accept the demo terms/,
  );
  r.run("eligibility", { adult: true, terms: true });
  assert.equal(r.s.eligible, true);
  const legacy = runner();
  legacy.run("eligibility", { adult: true, us: true, terms: true });
  assert.equal(legacy.s.eligible, true);
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
